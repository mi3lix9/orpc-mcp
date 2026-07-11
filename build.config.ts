import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  externals: ['@orpc/client', '@orpc/contract', '@orpc/json-schema', '@orpc/server', '@orpc/shared'],
})
