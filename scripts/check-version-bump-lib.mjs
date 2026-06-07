/**
 * Pure evaluation for the AGE-25 version-bump gate. Imported by
 * check-version-bump.mjs and architecture tests.
 */

export function readConst(content, name) {
  if (content == null) return null;
  const m = content.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`));
  return m ? m[1] : null;
}

/**
 * Decide which surfaces failed the version-bump gate.
 *
 * FIRST-SHIP rule: matched bundle paths absent at the base ref are a first
 * ship of the current artifact version, not a change to an already-shipped
 * bundle — they do not by themselves demand a version bump. A bump is still
 * demanded when any pre-existing matched path changed without a version bump.
 * An added-at-base bundle is a first ship of an existing artifact version, not
 * a change to it; staleness of newly staged bundles cannot slip through this
 * exemption because verify:clean-build independently regenerates every tracked
 * artifact and fails on drift — the two gates together stay sound.
 *
 * @param {object} input
 * @param {string[]} input.changed  paths changed between base and head
 * @param {string} input.baseRef    git ref for the comparison base (for errors)
 * @param {Array<{label:string, versionFile:string, versionConst:string, match:(f:string)=>boolean, bumpCmd:string}>} input.surfaces
 * @param {(ref: string, file: string) => string | null} input.fileAtRef
 * @returns {Array<{label:string, versionFile:string, versionConst:string, bumpCmd:string, baseVer:string, files:string[]}>}
 */
export function evaluateVersionBump({ changed, baseRef, surfaces, fileAtRef }) {
  const failures = [];
  for (const surface of surfaces) {
    const matched = changed.filter(surface.match);
    if (matched.length === 0) continue;

    const baseVer = readConst(fileAtRef(baseRef, surface.versionFile), surface.versionConst);
    const headVer = readConst(fileAtRef("HEAD", surface.versionFile), surface.versionConst);
    if (baseVer == null) continue; // version source did not exist at base → nothing to supersede

    // FIRST-SHIP: paths absent at base are a first ship of the current artifact
    // version, not a change to an already-shipped bundle. An added-at-base
    // bundle is a first ship of an existing artifact version, not a change to
    // it; staleness of newly staged bundles cannot slip through this exemption
    // because verify:clean-build independently regenerates every tracked
    // artifact and fails on drift — the two gates together stay sound.
    const preExistingChanged = matched.filter((file) => fileAtRef(baseRef, file) != null);
    if (preExistingChanged.length === 0) continue;

    if (baseVer === headVer) {
      failures.push({
        label: surface.label,
        versionFile: surface.versionFile,
        versionConst: surface.versionConst,
        bumpCmd: surface.bumpCmd,
        baseVer,
        files: preExistingChanged,
      });
    }
  }
  return failures;
}
