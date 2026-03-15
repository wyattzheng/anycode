declare module 'sql.js' {
    interface Database {
        run(sql: string, params?: any[]): Database
        exec(sql: string): QueryExecResult[]
        close(): void
    }

    interface QueryExecResult {
        columns: string[]
        values: any[][]
    }

    interface SqlJsStatic {
        Database: new (data?: ArrayLike<number>) => Database
    }

    export default function initSqlJs(config?: any): Promise<SqlJsStatic>
    export { Database, SqlJsStatic, QueryExecResult }
}
