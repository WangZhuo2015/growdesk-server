"""One-use bounded source edits on the migration review branch only."""
from pathlib import Path
import subprocess

BRANCH = "codex/migration-readiness-20260922"
if subprocess.check_output(["git", "branch", "--show-current"], text=True).strip() != BRANCH:
    raise SystemExit("Unexpected branch")


def edit(path, blob, transform):
    source = Path(path)
    if subprocess.check_output(["git", "hash-object", str(source)], text=True).strip() != blob:
        raise RuntimeError("Source changed: " + path)
    text = source.read_text()
    result = transform(text)
    if result == text:
        raise RuntimeError("Empty edit: " + path)
    source.write_text(result)


def once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError("Source anchor changed: " + old[:80])
    return text.replace(old, new)


def legacy(text):
    text = 'import { readObject, readString } from "./assert-json.js";\n' + text
    text = once(text, 'type Row = Record<string, any>;', 'type Row = Record<string, unknown>;')
    text = once(text, '  const prisma = database.prisma as any;', '''  const prisma = database.prisma;
  // A finite fixture model map is the dynamic seeding boundary. Prisma still
  // validates every create at runtime; source fields are never typed as any.
  const seed = database.prisma as unknown as Record<string, {
    create(input: { data: Record<string, unknown> }): Promise<unknown>;
  }>;''')
    text = once(text, 'await prisma[model].create({ data });', 'await seed[model]!.create({ data });')
    for model in ("vaccine", "vaccineDose", "vaccineScheduleEntry", "vaccineStrategyGroup"):
        text = once(text, 'await prisma.' + model + '.create({ data:', 'await seed.' + model + '!.create({ data:')
    text = once(text, '(food: any) => food.id', '(food: unknown) => readString(readObject(food).id)')
    text = once(text, 'const parseJson = (value: unknown) => {', 'const parseJson = (value: unknown): unknown => {')
    text = text.replace('catch {}', 'catch { /* Readiness retries and diagnostic parsing retain their bounded failure paths. */ }')
    return text


def objects(text):
    text = 'import { readObject, readRows, readString, hasHttpStatus } from "./assert-json.js";\n' + text
    text = text.replace('(error: any) => error.$metadata?.httpStatusCode === 404', '(error: unknown) => hasHttpStatus(error, 404)')
    text = once(text, 'const registered: any = await response.json();', 'const registered = readObject(readObject(await response.json()).data);')
    text = once(text, 'tokens.push(registered.data.accessToken);', 'tokens.push(readString(registered.accessToken));')
    text = once(text, 'userIds.push(registered.data.user.id);', 'userIds.push(readString(readObject(registered.user).id));')
    text = once(text, 'const families: any = await familiesResponse.json();', 'const families = readRows(readObject(await familiesResponse.json()).data);')
    text = once(text, 'assert.equal(families.data.length, 1);', 'assert.equal(families.length, 1);')
    text = once(text, 'familyIds.push(families.data[0].id);', 'familyIds.push(readString(families[0]!.id));')
    text = once(text, 'const baby: any = await babyResponse.json();', 'const baby = readObject(readObject(await babyResponse.json()).data);')
    text = once(text, 'babyId: baby.data.id', 'babyId: readString(baby.id)')
    text = once(text, 'const pending: any = await pendingResponse.json();', 'const pending = readObject(readObject(await pendingResponse.json()).data);')
    text = once(text, 'const attachment = pending.data;', 'const attachment = { id: readString(pending.id), objectKey: readString(pending.objectKey), uploadUrl: readString(pending.uploadUrl) };')
    return text


def http(text):
    text = 'import { readObject, readRows, readString, valueAt } from "./assert-json.js";\n' + text
    text = text.replace('body: any', 'body: unknown')
    text = text.replace('): any {', '): unknown {')
    first = text.index('function idFromBody(')
    last = text.index('async function runLegacyCrud(', first)
    text = text[:first] + '''function idFromBody(body: unknown): string {
  return readString(valueAt(body, "id") ?? valueAt(body, "data", "id") ?? valueAt(body, "record", "id"));
}

function versionFromBody(body: unknown): string {
  const value = valueAt(body, "version") ?? valueAt(body, "baseVersion")
    ?? valueAt(body, "data", "version") ?? valueAt(body, "record", "version");
  assert.match(String(value), /^[1-9]\\d*$/, `missing record version: ${bodySummary(body)}`);
  return String(value);
}

function listFromBody(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return readRows(body);
  const object = readObject(body);
  if (Array.isArray(object.data)) return readRows(object.data);
  if (Array.isArray(object.records)) return readRows(object.records);
  assert.fail(`legacy list response is not an array: ${bodySummary(body)}`);
}

''' + text[last:]
    replacements = {
      'createdBody.recordedById': 'valueAt(createdBody, "recordedById")',
      'registrationBody?.user?.id': 'valueAt(registrationBody, "user", "id")',
      'registrationBody?.family?.id': 'valueAt(registrationBody, "family", "id")',
      'registrationBody?.families?.[0]?.id': 'valueAt(registrationBody, "families", 0, "id")',
      'loginBody?.user?.id': 'valueAt(loginBody, "user", "id")',
      'meBody?.user?.id': 'valueAt(meBody, "user", "id")',
      'babyBody.familyId': 'valueAt(babyBody, "familyId")',
      'const savedRecipes: any[] = [];': 'const savedRecipes: Record<string, unknown>[] = [];',
      'assert.equal(recipe.babyId, babyId);': 'assert.equal(valueAt(recipe, "babyId"), babyId);',
      'assert.equal(recipe.date, recipeDate);': 'assert.equal(valueAt(recipe, "date"), recipeDate);',
      'assert.ok(recipe.id && recipe.createdAt);': 'assert.ok(valueAt(recipe, "id") && valueAt(recipe, "createdAt"));',
      'savedRecipes.push(recipe);': 'savedRecipes.push(readObject(recipe));',
      'pending.record.isCompleted': 'valueAt(pending, "record", "isCompleted")',
      'pending.record.completedDate': 'valueAt(pending, "record", "completedDate")',
      'idFromBody(pending.record)': 'idFromBody(valueAt(pending, "record"))',
      'inviteBody?.inviteCode': 'valueAt(inviteBody, "inviteCode")',
      'encodeURIComponent(inviteBody.inviteCode)': 'encodeURIComponent(readString(valueAt(inviteBody, "inviteCode")))',
      'registrationBBody?.user?.id': 'valueAt(registrationBBody, "user", "id")',
      'registrationBBody?.family?.id': 'valueAt(registrationBBody, "family", "id")',
      'registrationBBody?.families?.[0]?.id': 'valueAt(registrationBBody, "families", 0, "id")',
      'users.push(registrationBBody.user.id);': 'users.push(readString(valueAt(registrationBBody, "user", "id")));',
      'aiCreateBody?.session?.babyId': 'valueAt(aiCreateBody, "session", "babyId")',
      'aiCreateBody?.session': 'valueAt(aiCreateBody, "session")',
      'expectStatus(apiLogin, 200, "canonical API login")?.data?.accessToken': 'valueAt(expectStatus(apiLogin, 200, "canonical API login"), "data", "accessToken")',
      '(canonicalBody?.data ?? []).some((session: any)': 'listFromBody(canonicalBody).some((session)',
      'expectStatus(medicalCreate, 201, "canonical medical create")?.data': 'expectStatus(medicalCreate, 201, "canonical medical create")',
      'expectStatus(vaccineCreate, 201, "canonical vaccine create")?.data': 'expectStatus(vaccineCreate, 201, "canonical vaccine create")',
      'Array.isArray(canonicalTimelineBody?.data) ? canonicalTimelineBody.data : []': 'listFromBody(canonicalTimelineBody)',
      '(aiListBody?.sessions ?? []).some((session: any)': 'readRows(valueAt(aiListBody, "sessions")).some((session)',
      'aiPatchBody?.session?.title': 'valueAt(aiPatchBody, "session", "title")',
    }
    for old, new in replacements.items():
        text = once(text, old, new)
    text = text.replace('(entry: any)', '(entry)')
    for variable in ("aUserId", "aFamilyId", "bFamilyId", "apiToken"):
        text = once(text, 'assert.equal(typeof ' + variable + ', "string",', 'assert.ok(typeof ' + variable + ' === "string",')
    return text


edit("tests/integration/food.test.ts", "c05b3adfbbb76005764ef1830dbb32d4b4b5ec53", lambda text: text.replace('Record<string, any>', 'Record<string, unknown>'))
edit("tests/integration/legacy-golden-fixture.ts", "829fc4cee0d998835c29d714291ff9baeae58f6c", legacy)
edit("tests/integration/owned-object-storage.test.ts", "57f1f111a2179386c014bdbbe21080179a827a28", objects)
edit("tests/integration/web-http-parity.test.ts", "168cb6ceb2fe08c659565a61457bb50e4d297fe0", http)
