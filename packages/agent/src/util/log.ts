import { type Logger, consoleLogger } from "@any-code/utils"

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

const levelPriority: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
}

export type LogEntry = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): LogEntry
    clone(): LogEntry
    time(
        message: string,
        extra?: Record<string, any>,
    ): {
        stop(): void
        [Symbol.dispose](): void
    }
}

export interface LogOptions {
    print: boolean
    dev?: boolean
    level?: LogLevel
    logger?: Logger
}

/**
 * Log — multi-instance logging facility.
 *
 * Each instance owns its own logger, level, and write function.
 * Consumers instantiate via `new Log(options)` and call `.create()`.
 */
export class Log {
    private level: LogLevel = "INFO"
    private _logger: Logger
    private loggers = new Map<string, LogEntry>()
    private last = Date.now()

    private write: (msg: string) => number

    constructor(options?: { level?: LogLevel; logger?: Logger }) {
        this._logger = options?.logger ?? consoleLogger
        if (options?.level) this.level = options.level
        this.write = (msg: string) => {
            this._logger.error(msg)
            return msg.length
        }
    }

    private shouldLog(input: LogLevel): boolean {
        return levelPriority[input] >= levelPriority[this.level]
    }

    init(options: LogOptions & { writer?: (msg: string) => void }) {
        if (options.level) this.level = options.level
        if (options.logger) this._logger = options.logger
        if (options.writer) {
            this.write = (msg: string) => {
                options.writer!(msg)
                return msg.length
            }
        }
    }

    private formatError(error: Error, depth = 0): string {
        const result = error.message
        return error.cause instanceof Error && depth < 10
            ? result + " Caused by: " + this.formatError(error.cause, depth + 1)
            : result
    }

    create(tags?: Record<string, any>): LogEntry {
        tags = tags || {}

        const service = tags["service"]
        if (service && typeof service === "string") {
            const cached = this.loggers.get(service)
            if (cached) {
                return cached
            }
        }

        const self = this

        function build(message: any, extra?: Record<string, any>) {
            const prefix = Object.entries({
                ...tags,
                ...extra,
            })
                .filter(([_, value]) => value !== undefined && value !== null)
                .map(([key, value]) => {
                    const prefix = `${key}=`
                    if (value instanceof Error) return prefix + self.formatError(value)
                    if (typeof value === "object") return prefix + JSON.stringify(value)
                    return prefix + value
                })
                .join(" ")
            const next = new Date()
            const diff = next.getTime() - self.last
            self.last = next.getTime()
            return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
        }

        const result: LogEntry = {
            debug(message?: any, extra?: Record<string, any>) {
                if (self.shouldLog("DEBUG")) {
                    self.write("DEBUG " + build(message, extra))
                }
            },
            info(message?: any, extra?: Record<string, any>) {
                if (self.shouldLog("INFO")) {
                    self.write("INFO  " + build(message, extra))
                }
            },
            error(message?: any, extra?: Record<string, any>) {
                if (self.shouldLog("ERROR")) {
                    self.write("ERROR " + build(message, extra))
                }
            },
            warn(message?: any, extra?: Record<string, any>) {
                if (self.shouldLog("WARN")) {
                    self.write("WARN  " + build(message, extra))
                }
            },
            tag(key: string, value: string) {
                if (tags) tags[key] = value
                return result
            },
            clone() {
                return self.create({ ...tags })
            },
            time(message: string, extra?: Record<string, any>) {
                const now = Date.now()
                result.info(message, { status: "started", ...extra })
                function stop() {
                    result.info(message, {
                        status: "completed",
                        duration: Date.now() - now,
                        ...extra,
                    })
                }
                return {
                    stop,
                    [Symbol.dispose]() {
                        stop()
                    },
                }
            },
        }

        if (service && typeof service === "string") {
            this.loggers.set(service, result)
        }

        return result
    }
}
