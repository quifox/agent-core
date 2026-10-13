import { defineConfig } from 'vitest/config'

// HTTP, journals and subprocess tests share the machine's I/O budget.
export default defineConfig({ test: { maxWorkers: 2 } })
