const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export const logger = {
  info: (msg, ...args) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.cyan}INFO${colors.reset}  ${msg}`, ...args);
  },
  success: (msg, ...args) => {
    console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.green}PASS${colors.reset}  ${msg}`, ...args);
  },
  warn: (msg, ...args) => {
    console.warn(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.yellow}WARN${colors.reset}  ${msg}`, ...args);
  },
  error: (msg, ...args) => {
    console.error(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.red}FAIL${colors.reset}  ${msg}`, ...args);
  },
  debug: (msg, ...args) => {
    if (process.env.DEBUG) {
      console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${colors.magenta}DEBUG${colors.reset} ${msg}`, ...args);
    }
  },
};
