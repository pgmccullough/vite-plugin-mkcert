import path from 'path'
import process from 'process'

import pc from 'picocolors'
import { Logger } from 'vite'

import { PLUGIN_DATA_DIR } from '../lib/constant'
import { debug } from '../lib/logger'
import {
  copyDir,
  ensureDirExist,
  escape,
  exec,
  exists,
  getHash,
  prettyLog,
  readDir,
  readFile
} from '../lib/util'

import Config from './config'
import Downloader from './downloader'
import Record from './record'
import { BaseSource, GithubSource, CodingSource, LocalSource } from './source'
import VersionManger from './version'

export type SourceType = 'github' | 'coding' | 'local' | BaseSource

export type MkcertBaseOptions = {
  /**
   * Whether to force generate
   */
  force?: boolean

  /**
   * Automatically upgrade mkcert
   *
   * @default false
   */
  autoUpgrade?: boolean

  /**
   * Specify mkcert download source
   *
   * @default github
   */
  source?: SourceType

  /**
   * If your network is restricted, you can specify a local binary file instead of downloading, it should be an absolute path
   *
   * @default none
   */
  mkcertPath?: string

  /**
   * The location to save the files, such as key and cert files
   */
  savePath?: string

  /**
   * The name of private key file generated by mkcert
   */
  keyFileName?: string

  /**
   * The name of cert file generated by mkcert
   */
  certFileName?: string
}

export type MkcertOptions = MkcertBaseOptions & {
  logger: Logger
}

class Mkcert {
  private force?: boolean
  private autoUpgrade?: boolean
  private sourceType: SourceType
  private savePath: string
  private logger: Logger

  private source: BaseSource
  private localMkcert?: string
  private savedMkcert: string
  private keyFilePath: string
  private certFilePath: string

  private config: Config

  public static create(options: MkcertOptions) {
    return new Mkcert(options)
  }

  private constructor(options: MkcertOptions) {
    const {
      force,
      autoUpgrade,
      source,
      mkcertPath,
      savePath = PLUGIN_DATA_DIR,
      keyFileName = 'dev.pem',
      certFileName = 'cert.pem',
      logger
    } = options

    this.force = force
    this.logger = logger
    this.autoUpgrade = autoUpgrade
    this.localMkcert = mkcertPath
    this.savePath = path.resolve(savePath)
    this.keyFilePath = path.resolve(savePath, keyFileName)
    this.certFilePath = path.resolve(savePath, certFileName)
    this.sourceType = source || 'github'

    if (this.sourceType === 'github') {
      this.source = GithubSource.create()
    } else if (this.sourceType === 'coding') {
      this.source = CodingSource.create()
    } else if (this.sourceType === 'local') {
      this.source = LocalSource.create()
    } else {
      this.source = this.sourceType
    }

    this.savedMkcert = path.resolve(
      savePath,
      process.platform === 'win32' ? 'mkcert.exe' : 'mkcert'
    )

    console.log('hey1: ', this.localMkcert)
    console.log('hey: ', this.savedMkcert)

    this.config = new Config({ savePath: this.savePath })
  }

  private async getMkcertBinary() {
    let binary

    if (this.localMkcert) {
      if (await exists(this.localMkcert)) {
        binary = this.localMkcert
      } else {
        this.logger.error(
          pc.red(
            `${this.localMkcert} does not exist, please check the mkcertPath parameter`
          )
        )
      }
    } else if (await exists(this.savedMkcert)) {
      binary = this.savedMkcert
    }

    return binary
  }

  private async checkCAExists() {
    const files = await readDir(this.savePath)
    return files.some(file => file.includes('rootCA'))
  }

  private async retainExistedCA() {
    if (await this.checkCAExists()) {
      return
    }

    const mkcertBinary = await this.getMkcertBinary()
    const commandStatement = `${escape(mkcertBinary)} -CAROOT`

    debug(`Exec ${commandStatement}`)

    const commandResult = await exec(commandStatement)
    const caDirPath = path.resolve(
      commandResult.stdout.toString().replace(/\n/g, '')
    )

    if (caDirPath === this.savePath) {
      return
    }

    const caDirExists = await exists(caDirPath)

    if (!caDirExists) {
      return
    }

    await copyDir(caDirPath, this.savePath)
  }

  private async getCertificate() {
    const key = await readFile(this.keyFilePath)
    const cert = await readFile(this.certFilePath)

    return {
      key,
      cert
    }
  }

  private async createCertificate(hosts: string[]) {
    const names = hosts.join(' ')
    const mkcertBinary = await this.getMkcertBinary()

    if (!mkcertBinary) {
      debug(
        `Mkcert does not exist, unable to generate certificate for ${names}`
      )
    }

    await ensureDirExist(this.savePath)
    await this.retainExistedCA()

    const cmd = `${escape(mkcertBinary)} -install -key-file ${escape(
      this.keyFilePath
    )} -cert-file ${escape(this.certFilePath)} ${names}`

    await exec(cmd, {
      env: {
        ...process.env,
        CAROOT: this.savePath,
        JAVA_HOME: undefined
      }
    })

    this.logger.info(
      `The list of generated files:\n${this.keyFilePath}\n${this.certFilePath}`
    )
  }

  private getLatestHash = async () => {
    return {
      key: await getHash(this.keyFilePath),
      cert: await getHash(this.certFilePath)
    }
  }

  private async regenerate(record: Record, hosts: string[]) {
    await this.createCertificate(hosts)

    const hash = await this.getLatestHash()

    record.update({ hosts, hash })
  }

  public async init() {
    await ensureDirExist(this.savePath)
    await this.config.init()

    const mkcertBinary = await this.getMkcertBinary()

    if (!mkcertBinary) {
      await this.initMkcert()
    } else if (this.autoUpgrade) {
      await this.upgradeMkcert()
    }
  }

  private async getSourceInfo() {
    const sourceInfo = await this.source.getSourceInfo()

    if (!sourceInfo) {
      const message =
        typeof this.sourceType === 'string'
          ? `Unsupported platform. Unable to find a binary file for ${
              process.platform
            } platform with ${process.arch} arch on ${
              this.sourceType === 'github'
                ? 'https://github.com/FiloSottile/mkcert/releases'
                : 'https://liuweigl.coding.net/p/github/artifacts?hash=8d4dd8949af543159c1b5ac71ff1ff72'
            }`
          : 'Please check your custom "source", it seems to return invalid result'
      throw new Error(message)
    }

    return sourceInfo
  }

  private async initMkcert() {
    const sourceInfo = await this.getSourceInfo()
    if (this.sourceType !== 'local') {
      console.log('The mkcert does not exist, download it now') //DELETE
      debug('The mkcert does not exist, download it now')
      await this.downloadMkcert(sourceInfo.downloadUrl, this.savedMkcert)
    }
  }

  private async upgradeMkcert() {
    const versionManger = new VersionManger({ config: this.config })
    const sourceInfo = await this.getSourceInfo()

    if (!sourceInfo) {
      this.logger.error(
        'Can not obtain download information of mkcert, update skipped'
      )
      return
    }

    const versionInfo = versionManger.compare(sourceInfo.version)

    if (!versionInfo.shouldUpdate) {
      debug('Mkcert is kept latest version, update skipped')
      return
    }

    if (versionInfo.breakingChange) {
      debug(
        'The current version of mkcert is %s, and the latest version is %s, there may be some breaking changes, update skipped',
        versionInfo.currentVersion,
        versionInfo.nextVersion
      )
      return
    }

    debug(
      'The current version of mkcert is %s, and the latest version is %s, mkcert will be updated',
      versionInfo.currentVersion,
      versionInfo.nextVersion
    )

    if (this.sourceType !== 'local') {
      await this.downloadMkcert(sourceInfo.downloadUrl, this.savedMkcert)
    }
    versionManger.update(versionInfo.nextVersion)
  }

  private async downloadMkcert(sourceUrl: string, distPath: string) {
    console.log('srctype: ', this.sourceType)
    console.log('time to dl', sourceUrl, distPath) // DELETE
    const downloader = Downloader.create()
    await downloader.download(sourceUrl, distPath)
  }

  public async renew(hosts: string[]) {
    const record = new Record({ config: this.config })

    if (this.force) {
      debug(`Certificate is forced to regenerate`)

      await this.regenerate(record, hosts)
    }

    if (!record.contains(hosts)) {
      debug(
        `The hosts changed from [${record.getHosts()}] to [${hosts}], start regenerate certificate`
      )

      await this.regenerate(record, hosts)
      return
    }

    const hash = await this.getLatestHash()

    if (!record.equal(hash)) {
      debug(
        `The hash changed from ${prettyLog(record.getHash())} to ${prettyLog(
          hash
        )}, start regenerate certificate`
      )

      await this.regenerate(record, hosts)
      return
    }

    debug('Neither hosts nor hash has changed, skip regenerate certificate')
  }

  /**
   * Get certificates
   *
   * @param hosts host collection
   * @returns cretificates
   */
  public async install(hosts: string[]) {
    if (hosts.length) {
      await this.renew(hosts)
    }

    return await this.getCertificate()
  }
}

export default Mkcert
