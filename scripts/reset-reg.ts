import "dotenv/config";
import { setSetting } from "@/lib/settings";

// Dev helper: re-enable open registration in the settings table.
await setSetting("register_enabled", "on");
console.log("register_enabled = on");
process.exit(0);
