import escapeRegex from 'escape-string-regexp'
import { Command } from './command'
import { Context, Middleware, NextFunction } from './context'
import { Group, User, Database } from './database'
import { BotOptions, CQServer, ServerTypes } from './server'
import { Session } from './session'
import { simplify, defineProperty } from 'koishi-utils'
import { types } from 'util'
import help from './plugins/help'
import shortcut from './plugins/shortcut'
import suggest from './plugins/suggest'
import validate from './plugins/validate'

export interface AppOptions extends BotOptions {
  port?: number
  secret?: string
  path?: string
  type?: keyof ServerTypes
  bots?: BotOptions[]
  prefix?: string | string[]
  nickname?: string | string[]
  retryTimes?: number
  retryInterval?: number
  maxListeners?: number
  preferSync?: boolean
  queueDelay?: number | ((message: string, session: Session) => number)
  defaultAuthority?: number | ((session: Session) => number)
  quickOperationTimeout?: number
  similarityCoefficient?: number
  userCacheTimeout?: number
  groupCacheTimeout?: number
}

export interface MajorContext extends Context {
  except (...ids: number[]): Context
}

function createLeadingRE (patterns: string[], prefix = '', suffix = '') {
  return patterns.length ? new RegExp(`^${prefix}(${patterns.map(escapeRegex).join('|')})${suffix}`) : /^$/
}

const defaultOptions: AppOptions = {
  maxListeners: 64,
  retryInterval: 5000,
  userCacheTimeout: 60000,
  groupCacheTimeout: 300000,
  quickOperationTimeout: 500,
}

export enum Status { closed, opening, open, closing }

export class App extends Context {
  app = this
  options: AppOptions
  server: CQServer
  status = Status.closed

  _database: Database
  _commands: Command[] = []
  _commandMap: Record<string, Command> = {}
  _hooks: Record<keyof any, [Context, (...args: any[]) => any][]> = {}

  private _atMeRE: RegExp
  private _nameRE: RegExp
  private _prefixRE: RegExp
  private _middlewareCounter = 0
  private _middlewareSet = new Set<number>()
  private _getSelfIdsPromise: Promise<any>

  constructor (options: AppOptions = {}) {
    super({ groups: [], users: [], private: true })
    this.app = this
    options = this.options = { ...defaultOptions, ...options }
    if (!options.bots) options.bots = [options]

    defineProperty(this, '_commandMap', {})

    if (!options.type) {
      const { server } = options.bots[0]
      if (server) {
        options.type = server.split(':', 1)[0] as any
      } else if (options.port) {
        // TODO ws reverse support
        options.type = 'ws-reverse' as any
      }
    }

    const Server = CQServer.types[options.type]
    if (!Server) {
      throw new Error(
        `unsupported server type "${options.type}", expect ` +
        Object.keys(CQServer.types).map(type => `"${type}"`).join(', '))
    }
    this.server = new Server(this)

    const { nickname, prefix } = this.options
    const nicknames = Array.isArray(nickname) ? nickname : nickname ? [nickname] : []
    const prefixes = Array.isArray(prefix) ? prefix : [prefix || '']
    this._nameRE = createLeadingRE(nicknames, '@?', '([,，]\\s*|\\s+)')
    this._prefixRE = createLeadingRE(prefixes)

    // bind built-in event listeners
    this.on('message', this._applyMiddlewares.bind(this))
    this.middleware(this._preprocess.bind(this))

    this.on('parse', (message, { $parsed, messageType }, forced) => {
      if (forced && $parsed.prefix === null && !$parsed.nickname && messageType !== 'private') return
      const name = message.split(/\s/, 1)[0]
      const index = name.lastIndexOf('/')
      const command = this.app._commandMap[name.slice(index + 1).toLowerCase()]
      if (!command) return
      const result = command.parse(message.slice(name.length).trimStart())
      return { command, ...result }
    })

    this.plugin(validate)
    this.plugin(suggest)
    this.plugin(shortcut)
    this.plugin(help)
  }

  async getSelfIds () {
    const bots = this.server.bots.filter(bot => bot._get)
    if (!this._getSelfIdsPromise) {
      this._getSelfIdsPromise = Promise.all(bots.map(async (bot) => {
        if (bot.selfId || !bot._get) return
        const info = await bot.getLoginInfo()
        bot.selfId = info.userId
        this.prepare()
      }))
    }
    await this._getSelfIdsPromise
    return bots.map(bot => bot.selfId)
  }

  prepare () {
    const selfIds = this.server.bots
      .filter(bot => bot.selfId && bot._get)
      .map(bot => '' + bot.selfId)
    this._atMeRE = createLeadingRE(selfIds, '\\[CQ:at,qq=', '\\]\\s*')
  }

  async start () {
    this.status = Status.opening
    await this.parallelize('before-connect')
    this.status = Status.open
    this.logger('app').debug('started')
    this.emit('connect')
    this.server.ready()
  }

  async stop () {
    this.status = Status.closing
    await this.parallelize('before-disconnect')
    this.status = Status.closed
    this.logger('app').debug('stopped')
    this.emit('disconnect')
  }

  private async _preprocess (session: Session, next: NextFunction) {
    // strip prefix
    let capture: RegExpMatchArray
    let atMe = false
    let nickname = ''
    let prefix: string = null
    let message = simplify(session.message.trim())

    if (session.messageType !== 'private' && (capture = message.match(this._atMeRE))) {
      atMe = true
      nickname = capture[0]
      message = message.slice(capture[0].length)
    }

    if ((capture = message.match(this._nameRE))?.[0].length) {
      nickname = capture[0]
      message = message.slice(capture[0].length)
    }

    // eslint-disable-next-line no-cond-assign
    if (capture = message.match(this._prefixRE)) {
      prefix = capture[0]
      message = message.slice(capture[0].length)
    }

    // store parsed message
    session.$parsed = { atMe, nickname, prefix, message }
    session.$argv = this.parse(message, session, next, true)

    if (this.database) {
      if (session.messageType === 'group') {
        // attach group data
        const groupFields = new Set<Group.Field>(['flag', 'assignee'])
        this.emit('before-attach-group', session, groupFields)
        const group = await session.observeGroup(groupFields)

        // emit attach event
        if (await this.serialize(session, 'attach-group', session)) return

        // ignore some group calls
        if (group.flag & Group.Flag.ignore) return
        if (group.assignee !== session.selfId && !atMe) return
      }

      // attach user data
      const userFields = new Set<User.Field>(['flag'])
      this.emit('before-attach-user', session, userFields)
      const user = await session.observeUser(userFields)

      // emit attach event
      if (await this.serialize(session, 'attach-user', session)) return

      // ignore some user calls
      if (user.flag & User.Flag.ignore) return
    }

    await this.parallelize(session, 'attach', session)

    // execute command
    if (!session.$argv) return next()
    return session.$argv.command.execute(session.$argv)
  }

  private async _applyMiddlewares(session: Session) {
    // preparation
    const counter = this._middlewareCounter++
    this._middlewareSet.add(counter)
    const middlewares: Middleware[] = this._hooks[Context.MIDDLEWARE_EVENT as any]
      .filter(([context]) => context.match(session))
      .map(([_, middleware]) => middleware)

    // execute middlewares
    let index = 0, stack = ''
    const next = async (fallback?: NextFunction) => {
      const lastCall = new Error().stack.split('\n', 3)[2]
      if (index) {
        const capture = lastCall.match(/\((.+)\)/)
        stack = '\n  - ' + (capture ? capture[1] : lastCall.slice(7)) + stack
      }

      try {
        if (!this._middlewareSet.has(counter)) {
          throw new Error('isolated next function detected')
        }
        if (fallback) middlewares.push((_, next) => fallback(next))
        return middlewares[index++]?.(session, next)
      } catch (error) {
        if (!types.isNativeError(error)) {
          error = new Error(error as any)
        }
        const index = error.stack.indexOf(lastCall)
        this.logger('middleware').warn(`${session.message}\n${error.stack.slice(0, index)}Middleware stack:${stack}`)
      }
    }
    await next()

    // update middleware set
    this._middlewareSet.delete(counter)
    this.emit(session, 'after-middleware', session)

    // flush user & group data
    await session.$user?._update()
    await session.$group?._update()
  }
}
