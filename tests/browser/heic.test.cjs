const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "../..");
const bundle = fs.readFileSync(path.join(root, "main.js"));
const notice = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES"), "utf8");
const fixture = fs.readFileSync(path.join(root, "tests/fixtures/pattern.heic"));
const bootstrap = fs.readFileSync(path.join(__dirname, "obsidian-stub.js"));

test("배포 번들에서 실제 HEIC 변환과 업로드 흐름을 검증한다", { timeout: 90000 }, async (t) => {
	assert.ok(bundle.toString().includes(notice), "배포 번들에 원문 고지가 포함되어야 함");
	const assets = new Map([
		["/", ["text/html", Buffer.from('<!doctype html><script src="/obsidian-stub.js"></script><script src="/main.js"></script>')]],
		["/obsidian-stub.js", ["text/javascript", bootstrap]],
		["/main.js", ["text/javascript", bundle]],
		["/pattern.heic", ["image/heic", fixture]],
	]);
	const server = http.createServer((request, response) => {
		response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob:");
		const asset = assets.get(request.url);
		if (!asset) { response.writeHead(404); response.end(); return; }
		response.setHeader("Content-Type", asset[0]); response.end(asset[1]);
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise(resolve => server.close(resolve));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const options = process.env.CHROME_EXECUTABLE_PATH
		? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
		: { channel: "chrome" };
	const browser = await chromium.launch({ ...options, headless: true });
	t.after(() => browser.close());
	const externalRequests = [], pageErrors = [], networkRequests = [];
	async function openPage() {
		const context = await browser.newContext();
		await context.route("**/*", route => {
			const url = route.request().url(); networkRequests.push(url);
			if (url.startsWith(origin + "/")) return route.continue();
			externalRequests.push(url); return route.abort();
		});
		const page = await context.newPage();
		page.on("pageerror", error => pageErrors.push(error.message));
		await page.goto(origin);
		await page.evaluate(() => startPluginTest());
		return page;
	}

	await t.test("실제 HEIC를 JPEG로 업로드하고 다시 디코딩한다", async () => {
		const page = await openPage();
		const result = await page.evaluate(async () => {
			const { prevented } = await pluginTest.paste();
			const request = pluginTest.requests[0];
			const bytes = Uint8Array.from(atob(JSON.parse(request.body).content), char => char.charCodeAt(0));
			const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
			const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
			const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);
			const pixels = [[16,12],[48,12],[16,36],[48,36]].map(([x,y]) => Array.from(context.getImageData(x,y,1,1).data));
			const size = [bitmap.width, bitmap.height]; bitmap.close();
			return { prevented, url: request.url, text: pluginTest.view.editor.text, header: Array.from(bytes.slice(0,2)), footer: Array.from(bytes.slice(-2)), size, pixels, saved: pluginTest.saved.length };
		});
		assert.equal(result.prevented, true); assert.ok(result.url.endsWith(".jpg")); assert.match(result.text, /^!\[\]\(https:\/\/raw.githubusercontent.com\//);
		assert.deepEqual(result.header, [255,216]); assert.deepEqual(result.footer, [255,217]); assert.deepEqual(result.size, [64,48]); assert.equal(result.saved,0);
		[[240,20,30],[20,220,40],[30,40,230],[240,240,240]].forEach((rgb,i) => rgb.forEach((channel,c) => assert.ok(Math.abs(result.pixels[i][c] - channel) <= 20)));
	});

	await t.test("실제 변환 뒤 업로드 실패는 JPEG를 로컬에 저장한다", async () => {
		const page = await openPage();
		const result = await page.evaluate(async () => {
			pluginTest.state.uploadFails = true; await pluginTest.paste({ emptyMime:true, name:"PHOTO.HEIC" });
			const saved = pluginTest.saved[0];
			const sent = Array.from(atob(JSON.parse(pluginTest.requests[0].body).content), char => char.charCodeAt(0));
			return {saved, sent, text:pluginTest.view.editor.text, notices:pluginTest.notices};
		});
		assert.ok(result.saved.path.endsWith(".jpg")); assert.deepEqual(result.saved.bytes,result.sent); assert.deepEqual(result.saved.bytes.slice(0,2),[255,216]);
		assert.match(result.text,/^!\[\[/); assert.match(result.notices[0],/Image upload failed/);
	});

	await t.test("잘린 HEIC는 원본을 보관하며 같은 decoder에서 다음 정상 파일을 처리한다", async () => {
		const page = await openPage();
		const result = await page.evaluate(async () => {
			const corrupt = await pluginTest.paste({corrupt:true, type:"image/heif", name:"broken.heif"});
			const failure = {requests:pluginTest.requests.length,saved:pluginTest.saved[0],text:pluginTest.view.editor.text,notice:pluginTest.notices[0]};
			await pluginTest.paste();
			return {failure,original:corrupt.original,requestsAfter:pluginTest.requests.length};
		});
		assert.equal(result.failure.requests,0); assert.ok(result.failure.saved.path.endsWith(".heif")); assert.deepEqual(result.failure.saved.bytes,result.original);
		assert.match(result.failure.text,/^\[\[/); assert.match(result.failure.notice,/HEIC conversion failed/); assert.doesNotMatch(result.failure.notice,/Unknown error/);
		assert.match(result.failure.notice,/Export the original as JPEG/); assert.equal(result.requestsAfter,1);
	});

	await t.test("보관 설정을 끈 변환 실패는 업로드하거나 파일을 만들지 않는다", async () => {
		const page = await openPage();
		const result = await page.evaluate(async () => {
			pluginTest.plugin.settings.fallbackToLocal=false; await pluginTest.paste({corrupt:true});
			return {requests:pluginTest.requests.length,saved:pluginTest.saved.length,text:pluginTest.view.editor.text,notices:pluginTest.notices};
		});
		assert.equal(result.requests,0); assert.equal(result.saved,0); assert.equal(result.text,"\n"); assert.match(result.notices[0],/HEIC conversion failed/);
	});

	await t.test("취소하거나 플러그인을 종료한 뒤에는 새 업로드를 하지 않는다", async () => {
		for (const mode of ["cancel","unload"]) {
			const page=await openPage();
			const result=await page.evaluate(async (mode) => {
				await pluginTest.paste({[mode]:true});
				return {requests:pluginTest.requests.length,saved:pluginTest.saved.length,notices:pluginTest.notices.length};
			},mode);
			assert.deepEqual(result,{requests:0,saved:0,notices:0});
		}
	});
	assert.deepEqual(externalRequests,[]); assert.deepEqual(pageErrors,[]);
	assert.ok(networkRequests.every(url => assets.has(new URL(url).pathname)));
});
