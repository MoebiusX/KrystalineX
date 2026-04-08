import { createRoot } from "react-dom/client";
import { initBrowserOtel } from "./lib/otel";
import { createLogger } from "./lib/logger";
import App from "./App";
import "./index.css";
// Initialize i18n
import "./i18n";

const log = createLogger('main');

// Initialize OpenTelemetry BEFORE React renders
// This ensures fetch instrumentation is ready for all API calls
// Wrapped in try-catch so OTEL failures never crash the application
try {
    initBrowserOtel();
} catch (e) {
    log.warn({ err: e }, 'Failed to initialize browser telemetry');
}

createRoot(document.getElementById("root")!).render(<App />);
