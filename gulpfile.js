'use strict'

const {_extend, promisify} = require('util')
const fs = require('fs')
const path = require('path')

const addsrc = require('gulp-add-src')
const argv = require('yargs').argv
const browserify = require('browserify')
const buffer = require('vinyl-buffer')
const childExec = require('child_process').exec
const cleanCSS = require('gulp-clean-css')
const composer = require('gulp-uglify/composer')
const concat = require('gulp-concat')
const connect = require('connect')
const del = require('del')

const envify = require('gulp-envify')
const flatten = require('gulp-flatten')
const ghPages = require('gulp-gh-pages')
const gulp = require('gulp-help')(require('gulp'), {})
const gutil = require('gulp-util')
const http = require('http')
const livereload = require('gulp-livereload')
const ifElse = require('gulp-if-else')
const imagemin = require('gulp-imagemin')
const mkdirp = require('mkdirp')
const minifier = composer(require('uglify-es'), console)
const mount = require('connect-mount')

const notify = require('gulp-notify')
const runSequence = require('run-sequence')
const sass = require('gulp-sass')
const serveIndex = require('serve-index')
const serveStatic = require('serve-static')
const size = require('gulp-size')
const source = require('vinyl-source-stream')
const sourcemaps = require('gulp-sourcemaps')
const watchify = require('watchify')
const zip = require('gulp-zip')

const BUILD_DIR = process.env.BUILD_DIR || path.join(__dirname, 'build')
const BUILD_TARGET = argv.target ? argv.target : 'chrome'
const BUILD_TARGETS = ['chrome', 'firefox', 'electron']
const NODE_ENV = process.env.NODE_ENV || 'development'
const NODE_PATH = process.env.NODE_PATH || path.join(__dirname, 'node_modules')
const PRODUCTION = argv.production ? argv.production : (process.env.NODE_ENV === 'production')
const WATCHLINKED = argv.linked ? argv.linked : false
const WITHDOCS = argv.docs ? argv.docs : false

const writeFileAsync = promisify(fs.writeFile)

let bundlers = {bg: null, popup: null, tab: null, callstatus: null}
let isWatching
let sizeOptions = {showTotal: true, showFiles: true}


// Verify that the build target is valid.
if (!BUILD_TARGETS.includes(BUILD_TARGET)) {
    gutil.log(`Invalid build target: ${BUILD_TARGET}`)
    process.exit()
}

// Notify about some essential build presets.
if (PRODUCTION) gutil.log('(!) Gulp optimized for production')
gutil.log(`Build target: ${BUILD_TARGET}`)


/**
 * Generic browserify task used for multiple entrypoints.
 */
const jsEntry = (name) => {
    return (done) => {
        if (!bundlers[name]) {
            bundlers[name] = browserify({
                cache: {},
                debug: !PRODUCTION,
                entries: path.join(__dirname, 'src', 'js', `${name}.js`),
                packageCache: {},
            })
            if (isWatching) bundlers[name].plugin(watchify)
        }
        bundlers[name].bundle()
        .on('error', notify.onError('Error: <%= error.message %>'))
        .on('end', () => {
            done()
        })
        .pipe(source(`${name}.js`))
        .pipe(buffer())
        .pipe(ifElse(!PRODUCTION, () => sourcemaps.init({loadMaps: true})))
        .pipe(envify({NODE_ENV: NODE_ENV}))
        .pipe(ifElse(PRODUCTION, () => minifier()))

        .pipe(ifElse(!PRODUCTION, () => sourcemaps.write('./')))
        .pipe(gulp.dest(`./build/${BUILD_TARGET}/js`))
        .pipe(size(_extend({title: `${name}.js`}, sizeOptions)))
    }
}

/**
 * Generic scss task used for multiple entrypoints.
 */
const scssEntry = (name) => {
    return () => {
        return gulp.src(`./src/scss/${name}.scss`)
        .pipe(sass({
            includePaths: NODE_PATH,
            sourceMap: !PRODUCTION,
            sourceMapContents: !PRODUCTION,
            sourceMapEmbed: !PRODUCTION,
        }))
        .on('error', notify.onError('Error: <%= error.message %>'))
        .pipe(concat(`${name}.css`))
        .pipe(ifElse(PRODUCTION, () => cleanCSS({advanced: true, level: 2})))
        .pipe(gulp.dest(`./build/${BUILD_TARGET}/css`))
        .pipe(size(_extend({title: `scss-${name}`}, sizeOptions)))
        .pipe(ifElse(isWatching, livereload))
    }
}


gulp.task('assets', 'Copy click-to-dial assets to the build directory.', ['fonts'], () => {
    return gulp.src('./src/img/{*.png,*.jpg}', {base: './src'})
    .pipe(ifElse(PRODUCTION, imagemin))
    .pipe(addsrc('./LICENSE'))
    .pipe(addsrc('./README.md'))
    .pipe(addsrc('./src/_locales/**', {base: './src/'}))
    .pipe(addsrc('./src/js/lib/thirdparty/**/*.js', {base: './src/'}))
    .pipe(gulp.dest(`./build/${BUILD_TARGET}`))
    .pipe(size(_extend({title: 'assets'}, sizeOptions)))
    .pipe(ifElse(isWatching, livereload))
})


gulp.task('build', 'Clean existing build and regenerate a new one.', (done) => {
    if (BUILD_TARGET !== 'electron') runSequence('build-clean', ['assets', 'html', 'js-vendor', 'js-webext', 'scss'], done)
    else runSequence('build-clean', ['assets', 'html', 'js-electron-main', 'js-electron-webview', 'js-vendor', 'scss'], done)
})


gulp.task('build-clean', `Clean build directory ${path.join(BUILD_DIR, BUILD_TARGET)}`, (done) => {
    del([path.join(BUILD_DIR, BUILD_TARGET, '**')], {force: true}).then(() => {
        mkdirp(path.join(BUILD_DIR, BUILD_TARGET), done)
    })
})


gulp.task('docs', 'Generate documentation.', (done) => {
    let execCommand = `node ${NODE_PATH}/jsdoc/jsdoc.js ./src/js -R ./README.md -c ./.jsdoc.json -d ${BUILD_DIR}/docs`
    childExec(execCommand, undefined, (err, stdout, stderr) => {
        if (stderr) gutil.log(stderr)
        if (stdout) gutil.log(stdout)
        if (isWatching) livereload.changed('rtd.js')
        done()
    })
})


gulp.task('docs-deploy', 'Push the docs build directory to github pages.', function() {
    return gulp.src('./docs/build/**/*').pipe(ghPages())
})


gulp.task('fonts', 'Copy fonts to the build directory.', () => {
    const fontAwesomePath = path.join(NODE_PATH, 'font-awesome', 'fonts')
    const opensansPath = path.join(NODE_PATH, 'npm-font-open-sans', 'fonts')
    return gulp.src(path.join(fontAwesomePath, 'fontawesome-webfont.woff2'))
    .pipe(addsrc(path.join(opensansPath, 'Bold', 'OpenSans-Bold.woff2')))
    .pipe(addsrc(path.join(opensansPath, 'Italic', 'OpenSans-Italic.woff2')))
    .pipe(addsrc(path.join(opensansPath, 'SemiBold', 'OpenSans-Semibold.woff2')))
    .pipe(addsrc(path.join(opensansPath, 'SemiBoldItalic', 'OpenSans-SemiboldItalic.woff2')))
    .pipe(addsrc(path.join(opensansPath, 'Regular', 'OpenSans-Regular.woff2')))
    .pipe(flatten())
    .pipe(gulp.dest(`./build/${BUILD_TARGET}/fonts`))
    .pipe(size(_extend({title: 'fonts'}, sizeOptions)))
})


gulp.task('html', 'Add html to the build directory.', () => {
    let target = 'electron'
    if (BUILD_TARGET !== 'electron') target = 'webext'
    return gulp.src(path.join('src', 'html', `${target}*.html`))
    .pipe(ifElse(!PRODUCTION, () => addsrc(path.join('src', 'html', 'test.html'))))
    .pipe(flatten())
    .pipe(gulp.dest(`./build/${BUILD_TARGET}`))
})


gulp.task('js-electron', [
    'js-electron-main',
    'js-electron-webview',
    'js-vendor',
], (done) => {
    if (isWatching) livereload.changed('web.js')
    done()
})
gulp.task('js-electron-main', 'Generate electron main thread js.', ['js-electron-webview'], () => {
    return gulp.src('./src/js/electron_main.js', {base: './src/js/'})
    .pipe(gulp.dest(`./build/${BUILD_TARGET}`))
    .pipe(size(_extend({title: 'electron-main'}, sizeOptions)))
    .pipe(ifElse(isWatching, livereload))
})
gulp.task('js-electron-webview', 'Generate electron webview js.', jsEntry('electron_webview'))


gulp.task('js-vendor', 'Generate third-party vendor js.', jsEntry('vendor'))


gulp.task('js-webext', 'Generate webextension js.', [
    'js-webext-bg',
    'js-webext-callstatus',
    'js-webext-observer',
    'js-webext-options',
    'js-webext-popup',
    'js-webext-tab',
    `manifest-webext-${BUILD_TARGET}`,
], (done) => {
    if (isWatching) livereload.changed('web.js')
    done()
})
gulp.task('js-webext-bg', 'Generate the extension background entry js.', jsEntry('webext_bg'))
gulp.task('js-webext-callstatus', 'Generate the callstatus entry js.', jsEntry('webext_callstatus'))
gulp.task('js-webext-observer', 'Generate webextension observer js which runs in all tab frames.', jsEntry('webext_observer'))
gulp.task('js-webext-options', 'Generate webextension options js.', jsEntry('webext_options'))
gulp.task('js-webext-popup', 'Generate webextension popup/popout js.', jsEntry('webext_popup'))
gulp.task('js-webext-tab', 'Generate webextension tab js.', jsEntry('webext_tab'))


gulp.task('manifest-webext-chrome', 'Generate a web-extension manifest for Chrome.', (done) => {
    const manifestTarget = path.join(__dirname, 'build', BUILD_TARGET, 'manifest.json')
    let manifest = require('./src/manifest.json')
    manifest.options_ui.chrome_style = true
    writeFileAsync(manifestTarget, JSON.stringify(manifest, null, 4)).then(done)
})


gulp.task('manifest-webext-firefox', 'Generate a web-extension manifest for Firefox.', (done) => {
    const manifestTarget = path.join(__dirname, 'build', BUILD_TARGET, 'manifest.json')
    let manifest = require('./src/manifest.json')
    manifest.options_ui.browser_style = true
    manifest.applications = {
        gecko: {
            id: 'click-to-dial@web-extensions',
        },
    }
    writeFileAsync(manifestTarget, JSON.stringify(manifest, null, 4)).then(done)
})


gulp.task('scss', 'Compile all css.', [
    'scss-webext',
    'scss-webext-callstatus',
    'scss-webext-options',
    'scss-webext-print',
])

gulp.task('scss-webext', 'Generate popover webextension css.', scssEntry('webext'))
gulp.task('scss-webext-callstatus', 'Generate webextension callstatus dialog css.', scssEntry('webext_callstatus'))
gulp.task('scss-webext-options', 'Generate webextension options css.', scssEntry('webext_options'))
gulp.task('scss-webext-print', 'Generate webextension print css.', scssEntry('webext_print'))


gulp.task('watch', 'Start development server and watch for changes.', () => {
    const app = connect()
    isWatching = true
    livereload.listen({silent: false})
    app.use(serveStatic(path.join(__dirname, 'build')))
    app.use('/', serveIndex(path.join(__dirname, 'build'), {'icons': false}))
    app.use(mount('/docs', serveStatic(path.join(__dirname, 'docs', 'build'))))
    http.createServer(app).listen(8999)
    gulp.watch([
        path.join(__dirname, 'src', 'js', '**', '*.js'),
        `!${path.join(__dirname, 'src', 'js', 'lib', 'thirdparty', '**', '*.js')}`,
        `!${path.join(__dirname, 'src', 'js', 'vendor.js')}`,
        `!${path.join(__dirname, 'src', 'js', 'electron_main.js')}`,
        `!${path.join(__dirname, 'src', 'js', 'electron_webview.js')}`,
    ], () => {
        if (BUILD_TARGET !== 'electron') gulp.start('js-webext')
        if (WITHDOCS) gulp.start('docs')
    })

    if (WITHDOCS) {
        gutil.log('Watching documentation')
        gulp.watch([
            path.join(__dirname, '.jsdoc.json'),
            path.join(__dirname, 'README.md'),
            path.join(__dirname, 'docs', 'manuals', '**', '*.md'),
        ], () => {
            gulp.start('docs')
        })
    }

    if (WATCHLINKED) {
        gutil.log('Watching linked development packages')
        gulp.watch([
            path.join(NODE_PATH, 'jsdoc-rtd', 'static', 'styles', '*.css'),
            path.join(NODE_PATH, 'jsdoc-rtd', 'static', 'js', '*.js'),
            path.join(NODE_PATH, 'jsdoc-rtd', 'publish.js'),
            path.join(NODE_PATH, 'jsdoc-rtd', 'tmpl', '**', '*.tmpl'),
        ], ['docs'])
    }

    gulp.watch([
        path.join(__dirname, 'src', '_locales', '**', '*.json'),
        path.join(__dirname, 'src', 'html', '**', '*.html'),
        path.join(__dirname, 'src', 'js', 'lib', 'thirdparty', '**', '*.js'),
    ], ['assets'])

    if (BUILD_TARGET === 'electron') {
        gulp.watch([
            path.join(__dirname, 'src', 'js', 'electron_main.js'),
            path.join(__dirname, 'src', 'js', 'electron_webview.js'),
        ], ['js-electron-main', 'js-electron-webview'])
    } else {
        gulp.watch(path.join(__dirname, 'src', 'manifest.json'), [`manifest-webext-${BUILD_TARGET}`])
        gulp.watch(path.join(__dirname, 'src', 'scss', 'webext_callstatus.scss'), ['scss-webext-callstatus'])
        gulp.watch(path.join(__dirname, 'src', 'scss', 'webext_options.scss'), ['scss-webext-options'])
        gulp.watch([path.join(__dirname, 'src', 'scss', 'webext_print.scss')], ['scss-webext-print'])
    }

    gulp.watch(path.join(__dirname, 'src', 'js', 'vendor.js'), ['js-vendor'])

    gulp.watch([
        path.join(__dirname, 'src', 'scss', 'webext.scss'),
        path.join(__dirname, 'src', 'scss', '_*.scss'),
    ], ['scss-webext'])
})


gulp.task('zip', 'Generate a zip file from the build dir. Useful for extension distribution.', ['build'], function() {
    const _package = require('./package')
    const distributionName = `${_package.name.toLowerCase()}-${BUILD_TARGET}-${_package.version}.zip`
    // Build distributable extension.
    return gulp.src([
        `./build/${BUILD_TARGET}/**`,
    ], {base: `./build/${BUILD_TARGET}`})
    .pipe(zip(distributionName))
    .pipe(gulp.dest('./build'))
})