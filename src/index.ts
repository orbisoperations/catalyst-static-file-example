import { DurableObject } from "cloudflare:workers";

export interface Env {
	
	MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	STATIC_FILES: R2Bucket;
}

const ALARM = 30 * 1000 // 30s
const EQ_LIMIT = 10

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject<Env> {

	async alarmInit(alarmSwitch: boolean): Promise<boolean> {
		if (alarmSwitch) {
			//enable alarm
			if (!await this.ctx.storage.getAlarm()) {
				await this.ctx.storage.setAlarm(ALARM)
			}
		} else {
			//disable alarm
			await this.ctx.storage.deleteAlarm()
		}
		return alarmSwitch
	}

	async alarm(){
		const earthquakes = await this.ctx.storage.get<any[]>("earthquakes") ?? new Array<any[]>();

		// read in new earthquakes from r2

		// pick some random ones
		([] as any[]).forEach(element => {
			earthquakes.push(element)
		});

		while (earthquakes.length > EQ_LIMIT) {
			console.log(EQ_LIMIT, earthquakes.length, "popping")
			earthquakes.pop()
		}

	}


	async sayHello(name: string): Promise<string> {
		return `Hello, ${name}!`;
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

		return new Response(greeting);
	},
};
