export abstract class NamedError extends Error {
  abstract toObject(): { name: string; data: any }

  static create<Name extends string, Data>(name: Name, _phantom?: Data) {
    const result = class extends NamedError {
      public override readonly name = name as Name

      constructor(
        public readonly data: Data,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && "name" in input && input.name === name
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create<"UnknownError", { message: string }>("UnknownError")
}

export const NotFoundError = NamedError.create<"NotFoundError", {
  message: string
}>("NotFoundError")
