import * as findUp from 'find-up';
import { Buffer, Plugin } from 'oni-api';
import * as path from 'path';
import { noop, Subject } from 'rxjs';
import {
  debounceTime,
  map,
  pairwise,
  tap,
  startWith,
  filter
} from 'rxjs/operators';
import { Diagnostic, Position } from 'vscode-languageserver-types';
import { findPkg } from './require-package';

let tslintPath;

enum Errors {
  ERROR = 1,
  WARNING = 2,
  OFF = 3
}

interface LintPosition extends Position {
  position: number;
}

interface LintDiagnostic extends Diagnostic {
  file: string;
}

interface LintError {
  startPosition: LintPosition;
  endPosition: LintPosition;
  failure: string;
  name: string;
  ruleName: string;
  ruleSeverity: 'ERROR' | 'WARNING' | 'OFF';
}

interface FileErrors {
  [index: string]: LintDiagnostic[];
}

const onDirectoryChanged$: Subject<string> = new Subject();
const onBufferEnter$: Subject<Buffer> = new Subject();
const onBufferSaved$: Subject<Buffer> = new Subject();
const onStdoutData$: Subject<string> = new Subject();
const onErrors$: Subject<FileErrors> = new Subject();

export = {
  async activate(Oni: Plugin.Api) {
    onErrors$
      .pipe(
        startWith(null),
        pairwise(),
        tap(([, errors]) =>
          Object.keys(errors).forEach(f => {
            Oni.diagnostics.setErrors(f, 'tslint', errors[f]);
          })
        ),
        filter(([prevErrors]) => prevErrors),
        tap(([prevErrors, errors]) =>
          Object.keys(prevErrors).forEach(f => {
            if (prevErrors[f] && !errors[f]) {
              Oni.diagnostics.setErrors(f, 'tslint', []);
            }
          })
        )
      )
      .subscribe(noop);
    onDirectoryChanged$.subscribe(
      (dir: string): void => {
        tslintPath = findTsLint(dir);
      }
    );
    onStdoutData$
      .pipe(
        map(stdout => JSON.parse(stdout) as Array<LintError>),
        map(
          errors =>
            errors.map(e => ({
              file: path.normalize(e.name),
              message: `[${e.ruleName}] ${e.failure}`,
              severity: Errors[e.ruleSeverity],
              range: {
                start: {
                  line: e.startPosition.line,
                  character: e.startPosition.character
                },
                end: {
                  line: e.endPosition.line,
                  character: e.endPosition.character
                }
              }
            })) as Array<LintDiagnostic>
        ),
        map(
          errors =>
            errors.reduce((prev, curr) => {
              prev[curr.file] = prev[curr.file] || [];

              prev[curr.file].push({
                message: curr.message,
                range: curr.range,
                severity: curr.severity
              });

              return prev;
            }, {}) as FileErrors
        )
      )
      .subscribe(errors => onErrors$.next(errors));
    onBufferEnter$.pipe(debounceTime(500)).subscribe(buf => doLintForFile(buf));
    onBufferSaved$.pipe(debounceTime(500)).subscribe(buf => doLintForFile(buf));

    // trigger initial directory on activate.
    onDirectoryChanged$.next(process.cwd());
    // register subjects to listen to events to implement additional logic.
    Oni.workspace.onDirectoryChanged.subscribe((dir: string) =>
      onDirectoryChanged$.next(dir)
    );
    Oni.editors.activeEditor.onBufferEnter.subscribe((buf: Buffer) =>
      onBufferEnter$.next(buf)
    );
    Oni.editors.activeEditor.onBufferSaved.subscribe((buf: Buffer) =>
      onBufferSaved$.next(buf)
    );

    const doLintForFile = async (buf: Buffer): Promise<any> => {
      const files = [];
      if (!(isExternalAngularTemplate(buf) || isTypescript(buf))) {
        return;
      }

      const cwd = getCurrentWorkingDirectory(buf.filePath);
      const tslintConfigPath = await getLintConfig(cwd);

      if (!tslintConfigPath) {
        throw new Error('No tslint.json found; not running tslint.');
      }

      if (isExternalAngularTemplate(buf)) {
        files.push(`${cwd}/*.ts`);
      } else {
        files.push(buf.filePath);
      }

      return executeTsLint(tslintConfigPath, files, cwd);
    };
    const doLintForProject = async (
      buf: Buffer,
      autoFix: boolean = false
    ): Promise<any> => {
      if (!(isExternalAngularTemplate(buf) || isTypescript(buf))) {
        return;
      }
      const cwd = getCurrentWorkingDirectory(buf.filePath);
      const tslintConfigPath = await getLintConfig(cwd);

      if (!tslintConfigPath) {
        throw new Error('No tslint.json found; not running tslint.');
      }

      const tsConfigPath = await getTsConfig(cwd);

      let processArgs = [];
      if (tsConfigPath) {
        processArgs.push('--project', tsConfigPath);
      } else {
        processArgs.push(buf.filePath);
      }

      return executeTsLint(tslintConfigPath, processArgs, cwd, autoFix);
    };

    async function executeTsLint(
      configPath: string,
      args,
      cwd: string,
      autoFix = false
    ) {
      let processArgs = [];

      if (autoFix) {
        processArgs = processArgs.concat(['--fix']);
      }

      processArgs = processArgs.concat([
        '--force',
        '--format',
        'json',
        '--outputAbsolutePaths'
      ]);

      processArgs = processArgs.concat(['--config', configPath]);
      processArgs = processArgs.concat(args);

      return Oni.process.execNodeScript(
        tslintPath,
        processArgs,
        { cwd },
        (err: any, stdout: string): void => {
          if (err) {
            console.error(err);
            return;
          }
          onStdoutData$.next(stdout.trim());
        }
      );
    }

    function getCurrentWorkingDirectory(args) {
      return path.dirname(args);
    }

    async function getTsConfig(workingDirectory) {
      return findUp('tsconfig.json', { cwd: workingDirectory });
    }

    async function getLintConfig(workingDirectory) {
      return findUp('tslint.json', { cwd: workingDirectory });
    }

    function isExternalAngularTemplate(buf: Buffer): boolean {
      if (!buf.filePath) return false;
      const isHTML = buf.language === 'html';
      const isAngular =
        path.basename(buf.filePath).indexOf('.component.html') > -1;

      return isHTML && isAngular;
    }

    function isTypescript(buf: Buffer): boolean {
      if (!buf.filePath) return false;

      return buf.language === 'typescript';
    }

    function findTsLint(dir: string = process.cwd()): string {
      return `${path.dirname(findPkg(dir, 'tslint'))}/tslintCli.js`;
    }
  }
};
