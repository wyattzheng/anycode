declare module "*.txt" {
    const content: string;
    export default content;
}

declare class HTMLRewriter {
    on(selector: string, handlers: any): this;
    transform(response: any): any;
}
