let hydrate = require('@architect/hydrate')
let path = require('path')
let fs = require('fs')
let pkgVer = require('../../package.json').version
let ver = `Sandbox ${pkgVer}`
let watch = require('node-watch')
let { fingerprint, pathToUnix, updater } = require('@architect/utils')
let { readArc } = require('../helpers')
let readline = require('readline')
let { tmpdir } = require('os')
let sandbox = require('../sandbox')

module.exports = function cli (params = {}, callback) {
  if (!params.version) params.version = ver
  sandbox.start(params, function watching (err) {
    if (err) {
      // Hydration errors already reported, no need to log
      if (err.message !== 'hydration_error') console.log(err)
      sandbox.end()
      if (callback) callback(err)
      else process.exit(1)
    }
    else if (callback) callback()

    // Setup
    let update = updater('Sandbox')
    let deprecated = process.env.DEPRECATED
    let watcher = watch(process.cwd(), { recursive: true })
    let workingDirectory = pathToUnix(process.cwd())
    let separator = path.posix.sep

    // Arc stuff
    let { arc } = readArc()
    let arcFile = new RegExp(`${workingDirectory}${separator}(app\\.arc|\\.arc|arc\\.yaml|arc\\.json)`)
    let folderSetting = tuple => tuple[0] === 'folder'
    let staticFolder = arc.static && arc.static.some(folderSetting) ? arc.static.find(folderSetting)[1] : 'public'

    // Timers
    let lastEvent
    let arcEventTimer
    let rehydrateArcTimer
    let rehydrateSharedTimer
    let rehydrateStaticTimer
    let rehydrateViewsTimer
    let fingerprintTimer

    let ts = () => {
      if (!process.env.ARC_QUIET) {
        let date = new Date(lastEvent).toLocaleDateString()
        let time = new Date(lastEvent).toLocaleTimeString()
        console.log(`\n[${date}, ${time}]`)
      }
    }

    // Cleanup after any past runs
    let pauseFile = path.join(tmpdir(), '_pause-architect-sandbox-watcher')
    if (fs.existsSync(pauseFile)) {
      fs.unlinkSync(pauseFile)
    }
    let paused = false

    // Rehydrator
    function rehydrate ({ timer, only, msg }) {
      lastEvent = Date.now()
      clearTimeout(timer)
      timer = setTimeout(() => {
        ts()
        let start = Date.now()
        update.status(msg)
        hydrate.shared({ only }, () => {
          let end = Date.now()
          update.done(`Files rehydrated into functions in ${end - start}ms`)
        })
      }, 50)
    }

    // Listen for important keystrokes
    readline.emitKeypressEvents(process.stdin)
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    process.stdin.on('keypress', function now (input, key) {
      if (input === 'H') {
        rehydrate({
          timer: arcEventTimer,
          msg: 'Rehydrating all shared files...'
        })
      }
      if (input === 'S') {
        rehydrate({
          timer: rehydrateSharedTimer,
          only: 'shared',
          msg: 'Rehydrating src/shared...',
        })
      }
      if (input === 'V') {
        rehydrate({
          timer: rehydrateViewsTimer,
          only: 'views',
          msg: 'Rehydrating src/views...',
        })
      }
      if (key.sequence === '\u0003') {
        sandbox.end(function (err) {
          if (err) {
            update.err(err)
            process.exit(1)
          }
          if (callback) callback()
          process.exit(0)
        })
      }
    })

    /**
     * Watch for pertinent filesystem changes
     */
    watcher.on('change', function (event, fileName) {

      if (!paused && fs.existsSync(pauseFile)) {
        paused = true
        update.status('Watcher temporarily paused')
      }
      if (paused && !fs.existsSync(pauseFile)) {
        update.status('Watcher no longer paused')
        paused = false
      }

      // Event criteria
      let fileUpdate = event === 'update'
      let updateOrRemove = event === 'update' || event === 'remove'
      fileName = pathToUnix(fileName)

      /**
       * Reload routes upon changes to Architect project manifest
       */
      if (fileUpdate && fileName.match(arcFile) && !paused) {
        clearTimeout(arcEventTimer)
        arcEventTimer = setTimeout(() => {
          ts()
          // Always attempt to close the http server, but only reload if necessary
          sandbox.http.end()
          update.status('Architect project manifest changed')

          let start = Date.now()
          let quiet = process.env.ARC_QUIET
          process.env.ARC_QUIET = true
          sandbox.http.start({ quiet: true }, function (err, result) {
            if (!quiet) delete process.env.ARC_QUIET
            if (err) update.err(err)
            // HTTP passes back success message if it actually did need to (re)start
            if (result === 'HTTP successfully started') {
              let end = Date.now()
              update.done(`HTTP routes reloaded in ${end - start}ms`)
              if (deprecated) {
                rehydrate({
                  timer: rehydrateArcTimer,
                  only: 'arcFile',
                  msg: 'Rehydrating functions with new project manifest'
                })
              }
            }
          })
        }, 50)
      }

      /**
       * Rehydrate functions with shared files upon changes to src/shared
       */
      let isShared = fileName.includes(`${workingDirectory}/src/shared`)
      if (updateOrRemove && isShared && !paused) {
        rehydrate({
          timer: rehydrateSharedTimer,
          only: 'shared',
          msg: 'Shared file changed, rehydrating functions...'
        })
      }

      /**
       * Rehydrate functions with shared files upon changes to src/views
       */
      let isViews = fileName.includes(`${workingDirectory}/src/views`)
      if (updateOrRemove && isViews && !paused) {
        rehydrate({
          timer: rehydrateViewsTimer,
          only: 'views',
          msg: 'Views file changed, rehydrating views...'
        })
      }

      /**
       * Regenerate public/static.json upon changes to public/
       */
      if (updateOrRemove && arc.static && !paused &&
          fileName.includes(`${workingDirectory}/${staticFolder}`) &&
          !fileName.includes(`${workingDirectory}/${staticFolder}/static.json`)) {
        clearTimeout(fingerprintTimer)
        fingerprintTimer = setTimeout(() => {
          let start = Date.now()
          fingerprint({}, function next (err, result) {
            if (err) update.error(err)
            else {
              if (result) {
                let end = Date.now()
                rehydrate({
                  timer: rehydrateStaticTimer,
                  only: 'staticJson',
                  msg: `Regenerated public/static.json in ${end - start}ms`
                })
              }
            }
          })
        }, 50)
      }

      lastEvent = Date.now()
    })

    /**
     * Watch for sandbox errors
     */
    watcher.on('error', function (err) {
      update.error(`Error:`, err)
    })
  })
}
