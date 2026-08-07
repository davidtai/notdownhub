#!/usr/bin/env node
// After `tsc` builds the CLI, mark the entry point executable (0755).
//
// tsc emits dist/index.js as 0644. The file already carries a
// `#!/usr/bin/env node` shebang, so with the exec bit set it runs directly.
// This makes the documented from-source install work verbatim:
//   ln -s "$PWD/packages/cli/dist/index.js" /usr/local/bin/ndh   (see docs/install.md)
//
// Cross-platform: fs.chmodSync is a no-op on Windows, so this is safe there.

import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
chmodSync(entry, 0o755);
