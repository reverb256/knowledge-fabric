/**
 * Pi extension wrapper — re-exports the knowledge-fabric brain extension.
 *
 * This file lives in ~/.pi/agent/extensions/brain/index.ts and
 * simply re-exports the standalone knowledge-fabric package's
 * extension entry point.
 *
 * Install: cp pi-extension/index.ts ~/.pi/agent/extensions/brain/index.ts
 */

// Point this import at the standalone project checkout
import brain from "../knowledge-fabric/index.ts";

export default brain;
