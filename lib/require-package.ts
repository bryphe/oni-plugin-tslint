import * as path from 'path';
import * as readPkgUp from 'read-pkg-up';
import * as resolve from 'resolve';

export function findPkg(
  fspath: string = process.cwd(),
  pkgName: string
): string {
  const res = readPkgUp.sync({ cwd: fspath, normalize: false });
  const { root } = path.parse(fspath);
  if (
    res.pkg &&
    ((res.pkg.dependencies && res.pkg.dependencies[pkgName]) ||
      (res.pkg.devDependencies && res.pkg.devDependencies[pkgName]))
  ) {
    return resolve.sync(pkgName, { basedir: res.path });
  } else if (res.path) {
    const parent = path.resolve(path.dirname(res.path), '..');
    if (parent !== root) {
      return findPkg(parent, pkgName);
    }
  }
  return;
}

export async function requireLocalPkg(
  fspath: string,
  pkgName: string
): Promise<any> {
  const modulePath = findPkg(fspath, pkgName);

  if (modulePath) {
    try {
      return await import(modulePath);
    } catch (e) {
      console.warn(
        `Failed to load ${pkgName} from ${modulePath}. Using bundled`
      );
    }
  }

  return await import(pkgName);
}
