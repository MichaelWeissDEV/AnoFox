# Public Suffix List (vendored)

`public_suffix_list.dat` is the unmodified Public Suffix List from https://publicsuffix.org/list/public_suffix_list.dat.
It is licensed under the **Mozilla Public License 2.0** (https://mozilla.org/MPL/2.0/); the license notice is the header of the file
itself. The compact form used by AnoFox (`src/core/domain-utils/psl-data.ts`) is generated from this file by
`node scripts/build-psl.mjs`. To update: `node scripts/build-psl.mjs --update`, run the tests, commit both files.
MPL-2.0 is compatible with AnoFox's GPL-3.0-or-later (MPL-2.0 section 3.3, secondary license).
