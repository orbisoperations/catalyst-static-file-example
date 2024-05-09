import { DurableObject } from "cloudflare:workers";
import {z} from "zod"
import { createSchema, createYoga } from "graphql-yoga";
import {Hono, Context} from "hono"
import {createRemoteJWKSet, jwtVerify} from "jose"
export interface Env {
	EQ_DATA: DurableObjectNamespace<EQDataManager>;
	STATIC_FILES: R2Bucket;
	DEMO_ACTIVE: string
	CATALYST_JWK_URL: string
	CATALYST_APP_ID: string
}

type bindings = {
	EQ_DATA: DurableObjectNamespace<EQDataManager>;
	STATIC_FILES: R2Bucket;
	DEMO_ACTIVE: string
	CATALYST_JWK_URL: string
	CATALYST_APP_ID: string
}

const ALARM = 45 * 1000 // 45s
const EQ_LIMIT = 10


const eqDataResult = z.discriminatedUnion("success", [
	z.object({
		success: z.literal(false),
		error: z.string()
	})
])

type eqDataResult = z.infer<typeof eqDataResult>

const eqDataPoint = z.object({
	"EpicenterLongitude": z.string(),
	"EpicenterLatitude": z.string(),
	"LocalMagnitude": z.string(),
	expiry: z.number().optional(),
	uuid: z.string().optional()
})

type eqDataPoint = z.infer<typeof eqDataPoint>

const eqData = z.object({
	"cwaopendata": z.object({
		"Dataset": z.object({
			"Catalog": z.object({
				"EarthquakeInfo": eqDataPoint.array()
			})
		})
	})
})

type eqData = z.infer<typeof eqData>

const typeDefs = `
type Earthquake {
    EpicenterLongitude: String!
	EpicenterLatitude: String!
	LocalMagnitude: String!
	expiry: Float!
	UUID: String!
}

type Query {
    earthquakes: [Earthquake!]!
    _sdl: String!
}
`
const schema = createSchema({
	typeDefs: typeDefs,
	resolvers: {
		Query: {
			earthquakes: async (_, {}, c: Context) => {
				const demoSwitch = c.env.DEMO_ACTIVE === "true" ? true : false
				if (!demoSwitch || !Boolean(c.get('valid'))) return []
				const id = c.env.EQ_DATA.idFromName("default")
				const   stub: DurableObjectStub<EQDataManager> = c.env.EQ_DATA.get(id);
				return await stub.getEQData();
			},
			_sdl: () => typeDefs
		}
	}
})

/** A Durable Object's behavior is defined in an exported Javascript class */
export class EQDataManager extends DurableObject<Env> {

	async alarmInit(alarmSwitch: boolean): Promise<boolean> {
		if (alarmSwitch) {
			//enable alarm
			console.log("demo alarm enabled")
			console.log(await this.ctx.storage.getAlarm())
			if (await this.ctx.storage.getAlarm() == null) {
				console.log("set alarm val")
				await this.ctx.storage.setAlarm(Date.now() + ALARM)
			}
		} else {
			//disable alarm
			console.log("demo alarm disabled")
			await this.ctx.storage.deleteAlarm()
		}
		return alarmSwitch
	}

	async alarm(){
		let earthquakes = await this.ctx.storage.get<eqDataPoint[]>("earthquakes") ?? new Array<eqDataPoint>();

		console.log(await this.env.STATIC_FILES.list())
		// read in new earthquakes from r2
		const staticFile = await this.env.STATIC_FILES.get("earthquakes.json");
		if (!staticFile) {
			console.log(eqDataResult.parse({
				success: false,
				error: "json file not found"
			}))
			return
		}

		const eqDataFile = await staticFile.json<eqData>();
		// pick some random ones
		function getRandomInt(max: number) {
			return Math.floor(Math.random() * max);
		}

		const newEventLimit = getRandomInt(EQ_LIMIT);
		const newEventIndexes =
			[...Array(newEventLimit).keys()]
				.map(i => getRandomInt(eqDataFile.cwaopendata.Dataset.Catalog.EarthquakeInfo.length));

		console.log("new events limit", newEventLimit)
		console.log("new events indexes", newEventIndexes, eqDataFile.cwaopendata.Dataset.Catalog.EarthquakeInfo.length)

		newEventIndexes.forEach(index => {
			earthquakes.push(
				{
					uuid: crypto.randomUUID(),
					expiry: Date.now() + (ALARM * 2),
					...eqDataFile.cwaopendata.Dataset.Catalog.EarthquakeInfo[index]
				})
		})

		while (earthquakes.length > EQ_LIMIT) {
			console.log(earthquakes.length, EQ_LIMIT, "removing old elems from eq array")
			earthquakes = earthquakes.slice(1)
		}

		await this.ctx.storage.put("earthquakes", earthquakes)
		console.log("saved new eq range")
		console.log(eqDataResult.parse({
			success: true,
			data: earthquakes
		}))

		await this.ctx.storage.setAlarm(Date.now() + ALARM)
	}

	async getEQData() {
		return await this.ctx.storage.get<eqDataPoint[]>("earthquakes") ?? new Array<eqDataPoint>();
	}
}

type Variables = {
	valid: boolean
}

const app: Hono<{Bindings: bindings, Variables: Variables}> = new Hono()

app.use("/graphql", async (c) => {
	const JWKS = createRemoteJWKSet(new URL(c.env.CATALYST_JWK_URL))
	const token = c.req.header("Authorization") ? c.req.header("Authorization")!.split(" ")[1] : ""
	let valid = false
	try {
		const { payload, protectedHeader } = await jwtVerify(token, JWKS)
		valid = payload.claims != undefined && (payload.claims as string[]).includes(c.env.CATALYST_APP_ID)
	} catch (e) {
		console.error("error validating jwt: ", e)
		valid = false
	}
	c.set('valid', valid)
	const yoga = createYoga({
		schema: schema,
		graphqlEndpoint: "/graphql",
	});
	console.log("graphql handler")
	return yoga.handle(c.req.raw as Request, c);
})
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const id = env.EQ_DATA.idFromName("default")
		const stub = env.EQ_DATA.get(id)
		if (env.DEMO_ACTIVE == "true") {
			await stub.alarmInit(true)
		} else {
			await stub.alarmInit(false)
		}


		return app.fetch(request, env, ctx)
	},
};
