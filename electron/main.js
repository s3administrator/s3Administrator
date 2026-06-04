/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, shell, dialog } = require("electron")
const path = require("node:path")
const fs = require("node:fs")
const net = require("node:net")
const { spawn, fork } = require("node:child_process")

const isDev = !app.isPackaged

// In dev: app root = repo. In packaged: app root = resources/app.
const appRoot = isDev ? path.join(__dirname, "..") : path.join(process.resourcesPath, "app")
const userData = app.getPath("userData")
const pgDataDir = path.join(userData, "pgdata")
const secretsPath = path.join(userData, "secrets.json")

let mainWindow = null
let pgServer = null
let nextProc = null
let workerProc = null
let nextPort = 0

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function loadOrCreateSecrets() {
  if (fs.existsSync(secretsPath)) {
    try {
      return JSON.parse(fs.readFileSync(secretsPath, "utf8"))
    } catch {
      // fall through to regenerate
    }
  }
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true })
  const { randomBytes } = require("node:crypto")
  const secrets = {
    encryptionMasterKey: randomBytes(32).toString("hex"),
    encryptionSalt: randomBytes(16).toString("hex"),
    pgPassword: randomBytes(16).toString("hex"),
  }
  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  return secrets
}

const secrets = loadOrCreateSecrets()

function clearStalePgLock() {
  // After an unclean shutdown, postmaster.pid keeps the next start from
  // succeeding even though no postgres is actually running. Detect & remove.
  const lockPath = path.join(pgDataDir, "postmaster.pid")
  if (!fs.existsSync(lockPath)) return
  const contents = fs.readFileSync(lockPath, "utf8").split("\n")
  const pid = Number.parseInt(contents[0] ?? "", 10)
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0) // probe — throws if not running
      console.warn(`[pg] postmaster.pid points at live pid ${pid}; refusing to clear`)
      return
    } catch {
      // pid is stale
    }
  }
  console.warn(`[pg] removing stale postmaster.pid (pid=${pid || "n/a"})`)
  fs.rmSync(lockPath, { force: true })
}

async function startEmbeddedPostgres() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres")
  const port = await findFreePort()
  const password = secrets.pgPassword
  const databaseDir = pgDataDir
  const isFreshInstall = !fs.existsSync(databaseDir)
  if (!isFreshInstall) clearStalePgLock()

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password,
    port,
    persistent: true,
  })

  if (isFreshInstall) {
    await pg.initialise()
  }
  await pg.start()
  if (isFreshInstall) {
    await pg.createDatabase("s3admin")
  }

  pgServer = pg
  return `postgresql://postgres:${password}@127.0.0.1:${port}/s3admin?schema=public`
}

async function applySchema(databaseUrl) {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ENVIRONMENT: "COMMUNITY",
    ENCRYPTION_MASTER_KEY: secrets.encryptionMasterKey,
    ENCRYPTION_SALT: secrets.encryptionSalt,
    ELECTRON_RUN_AS_NODE: "1",
  }

  // Dev: use the Prisma CLI (installed) to sync the schema from source.
  // Packaged: run the bundled SQL migration runner (no Prisma CLI / schema
  // engine shipped). See scripts/runtime-migrate.ts + build-desktop.mjs.
  const [bin, args] = isDev
    ? [
        path.join(appRoot, "node_modules", "prisma", "build", "index.js"),
        ["db", "push", "--accept-data-loss"],
      ]
    : [path.join(appRoot, ".next", "standalone", "migrate.js"), []]

  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bin, ...args], { cwd: appRoot, env, stdio: "inherit" })
    proc.on("error", reject)
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`schema apply exited ${code}`))))
  })
}

async function startNextServer(databaseUrl) {
  nextPort = await findFreePort()

  if (isDev) {
    // In dev mode, run `next dev` against the source.
    const nextBin = path.join(appRoot, "node_modules", "next", "dist", "bin", "next")
    nextProc = spawn(process.execPath, [nextBin, "dev", "--port", String(nextPort)], {
      cwd: appRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ENVIRONMENT: "COMMUNITY",
        PORT: String(nextPort),
        ENCRYPTION_MASTER_KEY: secrets.encryptionMasterKey,
        ENCRYPTION_SALT: secrets.encryptionSalt,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: "inherit",
    })
  } else {
    // In packaged mode, run the standalone server bundle.
    const standaloneEntry = path.join(appRoot, ".next", "standalone", "server.js")
    nextProc = spawn(process.execPath, [standaloneEntry], {
      cwd: path.dirname(standaloneEntry),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ENVIRONMENT: "COMMUNITY",
        HOSTNAME: "127.0.0.1",
        PORT: String(nextPort),
        NODE_ENV: "production",
        ENCRYPTION_MASTER_KEY: secrets.encryptionMasterKey,
        ENCRYPTION_SALT: secrets.encryptionSalt,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: "inherit",
    })
  }

  nextProc.on("exit", (code) => {
    if (code !== 0 && !app.isQuitting) {
      console.error(`[next] exited with code ${code}`)
      dialog.showErrorBox("S3 Administrator", "The application server exited unexpectedly. Please restart.")
      app.quit()
    }
  })

  await waitForHttp(`http://127.0.0.1:${nextPort}/api/health`, 60_000)
}

async function startWorker(databaseUrl) {
  const workerScript = isDev
    ? path.join(appRoot, "src", "worker", "task-worker.ts")
    : path.join(appRoot, ".next", "standalone", "worker.js")

  if (isDev) {
    const tsxBin = path.join(appRoot, "node_modules", "tsx", "dist", "cli.mjs")
    workerProc = fork(tsxBin, [workerScript], {
      cwd: appRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ENVIRONMENT: "COMMUNITY",
        ENCRYPTION_MASTER_KEY: secrets.encryptionMasterKey,
        ENCRYPTION_SALT: secrets.encryptionSalt,
        ELECTRON_RUN_AS_NODE: "1",
      },
      execPath: process.execPath,
      stdio: "inherit",
    })
  } else {
    workerProc = fork(workerScript, [], {
      cwd: appRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ENVIRONMENT: "COMMUNITY",
        NODE_ENV: "production",
        ENCRYPTION_MASTER_KEY: secrets.encryptionMasterKey,
        ENCRYPTION_SALT: secrets.encryptionSalt,
        ELECTRON_RUN_AS_NODE: "1",
      },
      execPath: process.execPath,
      stdio: "inherit",
    })
  }

  workerProc.on("exit", (code) => {
    if (code !== 0 && !app.isQuitting) {
      console.warn(`[worker] exited with code ${code}`)
    }
  })
}

function waitForHttp(url, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = require("node:http").get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) return resolve()
        retry()
      })
      req.on("error", retry)
      req.setTimeout(2_000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`))
      setTimeout(tick, 250)
    }
    tick()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "S3 Administrator",
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: "deny" }
  })

  mainWindow.loadURL(`http://127.0.0.1:${nextPort}/dashboard`)
}

async function bootstrap() {
  try {
    const databaseUrl = await startEmbeddedPostgres()
    await applySchema(databaseUrl)
    await Promise.all([startNextServer(databaseUrl), startWorker(databaseUrl)])
    createWindow()
  } catch (err) {
    console.error("[bootstrap] failed:", err)
    dialog.showErrorBox("S3 Administrator failed to start", String(err?.stack ?? err))
    app.quit()
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on("before-quit", async (event) => {
  if (app.isQuitting) return
  event.preventDefault()
  app.isQuitting = true
  try {
    workerProc?.kill()
    nextProc?.kill()
    if (pgServer) await pgServer.stop()
  } catch (err) {
    console.warn("[shutdown] error:", err)
  } finally {
    app.exit(0)
  }
})

app.whenReady().then(bootstrap)
