import { type AppEnv } from './src/env-schema.ts'

declare global {
	interface Env extends AppEnv {}

	namespace Cloudflare {
		interface Env {
			PLAN_LIMITS?: string
		}
	}

	interface CustomExportedHandler<Props = {}> {
		fetch: (
			request: Request,
			env: Env,
			ctx: ExecutionContext<Props>,
		) => Response | Promise<Response>
	}
}

export {}
