#!/usr/bin/env node
/**
 * `acttrace` command-line entry point. Thin shim over {@link main} in `./index.js` so
 * `npx acttrace verify <path>` works. Mirrors Python's `cendor.acttrace.cli` module, exposed via
 * `[project.scripts]`. {@link main} takes the bare subcommand array, so slice off `node` + script.
 */
import { main } from './index.js';

process.exit(main(process.argv.slice(2)));
