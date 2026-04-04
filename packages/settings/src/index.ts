import fs from "fs"
import os from "os"
import path from "path"
import {
  ANYCODE_DIR_NAME,
  SETTINGS_FILE_NAME,
  SettingsModel,
  type UserSettingsFile,
} from "./shared"

export * from "./shared"

export interface SettingsStoreOptions {
  homeDir?: string
  anycodeDir?: string
  settingsPath?: string
}

export class SettingsStore {
  readonly anycodeDir: string
  readonly path: string

  constructor(options: SettingsStoreOptions = {}) {
    this.anycodeDir = options.anycodeDir ?? path.join(options.homeDir ?? os.homedir(), ANYCODE_DIR_NAME)
    this.path = options.settingsPath ?? path.join(this.anycodeDir, SETTINGS_FILE_NAME)
  }

  read() {
    try {
      fs.mkdirSync(this.anycodeDir, { recursive: true })
      return new SettingsModel(JSON.parse(fs.readFileSync(this.path, "utf-8")))
    } catch {
      return new SettingsModel({})
    }
  }

  write(input: SettingsModel | UserSettingsFile | unknown) {
    const model = input instanceof SettingsModel ? new SettingsModel(input.toJSON()) : new SettingsModel(input)
    fs.mkdirSync(this.anycodeDir, { recursive: true })
    fs.writeFileSync(this.path, JSON.stringify(model.toJSON(), null, 2) + "\n")
    return model
  }
}
