// 必须存在:否则 vitest 会向上找到仓库根的 vite.config.ts,
// 沿用其 include(src/**/*.test.ts)导致 server/test 一个都跑不到。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
