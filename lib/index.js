// @ts-check

const path = require("path")
const os = require("os")
const exec = require("child_process").exec

const findUp = require("find-up")

const tslintPath = path.join(__dirname, "..", "node_modules", "tslint", "lib", "tslint-cli.js")

let lastErrors = {}
let lastArgs = null

const activate = (Oni) => {

    const doLintForFile = async (args) => {
        if (!args.filePath) {
            return
        }

        const currentWorkingDirectory = getCurrentWorkingDirectory(args.filePath)
        const filePath = await getLintConfig(currentWorkingDirectory)

        if (!filePath) {
            throw new Error("No tslint.json found; not running tslint.")
        }

        const errors = await executeTsLint(filePath, [args.filePath], currentWorkingDirectory)

        // When running for a single file, only the filename will be included in the results
        const fileName = path.basename(args.filePath)

        const fileErrors = errors[fileName] || []

        Oni.diagnostics.setErrors(args.filePath, "tslint-ts", fileErrors, "yellow")

        if (!fileErrors || fileErrors.length === 0) {
            lastErrors[args.filePath] = null
        }
    }

    const doLintForProject = async (args, autoFix) => {
        if (!args.filePath) {
            return
        }

        lastArgs = args

        const currentWorkingDirectory = getCurrentWorkingDirectory(args.filePath)
        const filePath = await getLintConfig(currentWorkingDirectory)
        if (!filePath) {
            throw new Error("No tslint.json found; not running tslint.")
        }
        const project = await getTsConfig(currentWorkingDirectory)
        let processArgs = []
        if (project) {
            processArgs.push("--project", project)
        } else {
            processArgs.push(args.filePath)
        }

        const errors = await executeTsLint(filePath, processArgs, currentWorkingDirectory, autoFix)
                // Send all updated errors
        Object.keys(errors).forEach(f => {
            Oni.diagnostics.setErrors(f, "tslint-ts", errors[f], "yellow")
        })

        // Send all errors that were cleared
        Object.keys(lastErrors).forEach(f => {
            if (lastErrors[f] && !errors[f]) {
                Oni.diagnostics.setErrors(f, "tslint-ts", [], "yellow")
            }
        })

        lastErrors = errors
    }

    Oni.editors.activeEditor.onBufferEnter.subscribe((buf) => doLintForProject(buf, false))
    Oni.editors.activeEditor.onBufferSaved.subscribe((buf) => doLintForFile(buf))

    Oni.commands.registerCommand("tslint.fix", (args) => {
        doLintForProject(lastArgs, true)
    })

    async function executeTsLint(configPath, args, workingDirectory, autoFix) {

        let processArgs = []

        if (autoFix) {
            processArgs = processArgs.concat(["--fix"])
        }

        processArgs = processArgs.concat(["--force", "--format", "json"])

        processArgs = processArgs.concat(["--config", configPath])
        processArgs = processArgs.concat(args)

        return new Promise((resolve, reject) => {
            Oni.process.execNodeScript(tslintPath, processArgs, { cwd: workingDirectory },
                (err, stdout, stderr) => {

                if (err) {
                    console.error(err)
                    reject(err)
                    return
                }

                const errorOutput = stdout.trim()

                const lintErrors = JSON.parse(errorOutput)

                const errorsWithFileName = lintErrors.map(e => ({
                    type: null,
                    file: path.normalize(e.name),
                    message: `[${e.ruleName}] ${e.failure}`,
                    severity: 2 /* Warning */,
                    range: {
                        start: {
                            line: e.startPosition.line,
                            character: e.startPosition.character,
                        },
                        end: {
                            line: e.endPosition.line,
                            character: e.endPosition.character
                        }
                    }
                }))

                const errors = errorsWithFileName.reduce((prev, curr) => {
                    prev[curr.file] = prev[curr.file] || []

                    prev[curr.file].push({
                        message: curr.message,
                        range: curr.range,
                        severity: curr.severity,
                        type: curr.type,
                    })

                    return prev
                }, {})

                resolve(errors)
            })

        })
    }

    function getCurrentWorkingDirectory(args) {
        return path.dirname(args)
    }

    async function getTsConfig(workingDirectory) {
        return findUp("tsconfig.json", { cwd: workingDirectory })
    }

    async function getLintConfig(workingDirectory) {
        return findUp("tslint.json", { cwd: workingDirectory })
    }
}

module.exports = {
    activate
}
