// @ts-check
/* eslint no-shadow: "off" */

/** @typedef {import('ses').ImportHook} ImportHook */
/** @typedef {import('./types.js').ParseFn} ParseFn */
/** @typedef {import('./types.js').CompartmentDescriptor} CompartmentDescriptor */
/** @typedef {import('./types.js').Application} Application */
/** @typedef {import('./types.js').CompartmentMapDescriptor} CompartmentMapDescriptor */
/** @typedef {import('./types.js').ExecuteFn} ExecuteFn */
/** @typedef {import('./types.js').ReadFn} ReadFn */
/** @typedef {import('./types.js').ReadPowers} ReadPowers */
/** @typedef {import('./types.js').HashFn} HashFn */
/** @typedef {import('./types.js').ComputeSourceLocationHook} ComputeSourceLocationHook */
/** @typedef {import('./types.js').LoadArchiveOptions} LoadArchiveOptions */
/** @typedef {import('./types.js').ExecuteOptions} ExecuteOptions */

import { ZipReader } from '@endo/zip';
import { link } from './link.js';
import { parsePreCjs } from './parse-pre-cjs.js';
import { parseJson } from './parse-json.js';
import { parsePreMjs } from './parse-pre-mjs.js';
import { parseLocatedJson } from './json.js';
import { unpackReadPowers } from './powers.js';
import { join } from './node-module-specifier.js';
import { assertCompartmentMap } from './compartment-map.js';

const DefaultCompartment = Compartment;

const { quote: q, details: d } = assert;

const textDecoder = new TextDecoder();

/** @type {Record<string, ParseFn>} */
const parserForLanguage = {
  'pre-cjs-json': parsePreCjs,
  'pre-mjs-json': parsePreMjs,
  json: parseJson,
};

/**
 * @callback ArchiveImportHookMaker
 * @param {string} packageLocation
 * @param {string} packageName
 * @returns {ImportHook}
 */

/**
 * @param {(path: string) => Uint8Array} get
 * @param {Record<string, CompartmentDescriptor>} compartments
 * @param {string} archiveLocation
 * @param {HashFn} [computeSha512]
 * @param {ComputeSourceLocationHook} [computeSourceLocation]
 * @returns {ArchiveImportHookMaker}
 */
const makeArchiveImportHookMaker = (
  get,
  compartments,
  archiveLocation,
  computeSha512 = undefined,
  computeSourceLocation = undefined,
) => {
  // per-assembly:
  /** @type {ArchiveImportHookMaker} */
  const makeImportHook = (packageLocation, packageName) => {
    // per-compartment:
    const { modules } = compartments[packageLocation];
    /** @type {ImportHook} */
    const importHook = async moduleSpecifier => {
      // per-module:
      const module = modules[moduleSpecifier];
      if (module.parser === undefined) {
        throw new Error(
          `Cannot parse module ${q(moduleSpecifier)} in package ${q(
            packageLocation,
          )} in archive ${q(archiveLocation)}`,
        );
      }
      const parse = parserForLanguage[module.parser];
      if (parse === undefined) {
        throw new Error(
          `Cannot parse ${q(module.parser)} module ${q(
            moduleSpecifier,
          )} in package ${q(packageLocation)} in archive ${q(archiveLocation)}`,
        );
      }
      const moduleLocation = `${packageLocation}/${module.location}`;
      const moduleBytes = get(moduleLocation);

      if (computeSha512 !== undefined && module.sha512 !== undefined) {
        const sha512 = computeSha512(moduleBytes);
        if (sha512 !== module.sha512) {
          throw new Error(
            `Module ${q(module.location)} of package ${q(
              packageLocation,
            )} in archive ${q(
              archiveLocation,
            )} failed a SHA-512 integrity check`,
          );
        }
      }

      let sourceLocation = `file:///${moduleLocation}`;
      if (packageName !== undefined) {
        const base = packageName
          .split('/')
          .slice(-1)
          .join('/');
        sourceLocation = `.../${join(base, moduleSpecifier)}`;
      }
      if (computeSourceLocation !== undefined) {
        sourceLocation =
          computeSourceLocation(packageLocation, moduleSpecifier) ||
          sourceLocation;
      }

      // eslint-disable-next-line no-await-in-loop
      const { record } = await parse(
        moduleBytes,
        moduleSpecifier,
        sourceLocation,
        packageLocation,
      );
      return record;
    };
    return importHook;
  };
  return makeImportHook;
};

const makeFeauxModuleExportsNamespace = Compartment => {
  // @ts-ignore Unclear at time of writing why Compartment type is not
  // constructible.
  const compartment = new Compartment(
    {},
    {},
    {
      resolveHook() {
        return '.';
      },
      importHook() {
        return {
          imports: [],
          execute() {},
        };
      },
    },
  );
  return compartment.module('.');
};

/**
 * @param {Uint8Array} archiveBytes
 * @param {string} [archiveLocation]
 * @param {Object} [options]
 * @param {string} [options.expectedSha512]
 * @param {HashFn} [options.computeSha512]
 * @param {Record<string, unknown>} [options.modules]
 * @param {Compartment} [options.Compartment]
 * @param {ComputeSourceLocationHook} [options.computeSourceLocation]
 * @returns {Promise<Application>}
 */
export const parseArchive = async (
  archiveBytes,
  archiveLocation = '<unknown>',
  options = {},
) => {
  const {
    computeSha512 = undefined,
    expectedSha512 = undefined,
    computeSourceLocation = undefined,
    Compartment = DefaultCompartment,
    modules = undefined,
  } = options;

  const archive = new ZipReader(archiveBytes, { name: archiveLocation });

  // Track all modules that get loaded, all files that are used.
  const unseen = new Set(archive.files.keys());
  assert(
    unseen.size >= 2,
    `Archive failed sanity check: should contain at least a compartment map file and one module file.`,
  );

  /**
   * @param {string} path
   */
  const get = path => {
    unseen.delete(path);
    return archive.read(path);
  };

  const compartmentMapBytes = get('compartment-map.json');

  let sha512;
  if (computeSha512 !== undefined) {
    sha512 = computeSha512(compartmentMapBytes);
  }
  if (expectedSha512 !== undefined) {
    if (sha512 === undefined) {
      throw new Error(
        `Cannot verify expectedSha512 without also providing computeSha512, for archive ${archiveLocation}`,
      );
    }
    if (sha512 !== expectedSha512) {
      throw new Error(
        `Archive compartment map failed a SHA-512 integrity check, expected ${expectedSha512}, got ${sha512}, for archive ${archiveLocation}`,
      );
    }
  }

  const compartmentMapText = textDecoder.decode(compartmentMapBytes);
  const compartmentMap = parseLocatedJson(
    compartmentMapText,
    'compartment-map.json',
  );
  assertCompartmentMap(compartmentMap);

  const {
    compartments,
    entry: { module: moduleSpecifier },
  } = compartmentMap;

  // Archive integrity checks: ensure every module is pre-loaded so its hash
  // gets checked, and ensure that every file in the archive is used, and
  // therefore checked.
  if (computeSha512 !== undefined) {
    const makeImportHook = makeArchiveImportHookMaker(
      get,
      compartments,
      archiveLocation,
      computeSha512,
      computeSourceLocation,
    );
    // A weakness of the current Compartment design is that the `modules` map
    // must be given a module namespace object that passes a brand check.
    // We don't have module instances for the preload phase, so we supply fake
    // namespaces.
    const { compartment } = link(compartmentMap, {
      makeImportHook,
      parserForLanguage,
      modules: Object.fromEntries(
        Object.keys(modules || {}).map(specifier => {
          return [specifier, makeFeauxModuleExportsNamespace(Compartment)];
        }),
      ),
      Compartment,
    });

    await compartment.load(moduleSpecifier);
    assert(
      unseen.size === 0,
      d`Archive contains extraneous files: ${q([...unseen])} in ${q(
        archiveLocation,
      )}`,
    );
  }

  /** @type {ExecuteFn} */
  const execute = options => {
    const {
      globals,
      globalLexicals,
      modules,
      transforms,
      __shimTransforms__,
      Compartment,
    } = options || {};
    const makeImportHook = makeArchiveImportHookMaker(
      get,
      compartments,
      archiveLocation,
      computeSha512,
      computeSourceLocation,
    );
    const { compartment } = link(compartmentMap, {
      makeImportHook,
      parserForLanguage,
      globals,
      globalLexicals,
      modules,
      transforms,
      __shimTransforms__,
      Compartment,
    });
    return compartment.import(moduleSpecifier);
  };

  return { import: execute, sha512 };
};

/**
 * @param {ReadFn | ReadPowers} readPowers
 * @param {string} archiveLocation
 * @param {LoadArchiveOptions} [options]
 * @returns {Promise<Application>}
 */
export const loadArchive = async (
  readPowers,
  archiveLocation,
  options = {},
) => {
  const { read, computeSha512 } = unpackReadPowers(readPowers);
  const { expectedSha512, computeSourceLocation, modules } = options;
  const archiveBytes = await read(archiveLocation);
  return parseArchive(archiveBytes, archiveLocation, {
    computeSha512,
    expectedSha512,
    computeSourceLocation,
    modules,
  });
};

/**
 * @param {ReadFn | ReadPowers} readPowers
 * @param {string} archiveLocation
 * @param {ExecuteOptions & LoadArchiveOptions} options
 * @returns {Promise<Object>}
 */
export const importArchive = async (readPowers, archiveLocation, options) => {
  const archive = await loadArchive(readPowers, archiveLocation, options);
  return archive.import(options);
};
