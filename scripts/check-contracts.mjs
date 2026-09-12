import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCanonicalOpenApi } from "./contract-generator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputFile = path.join(root, "contracts", "openapi.json");

async function main() {
  console.log("Checking canonical OpenAPI specification consistency...");

  let existingContent;
  try {
    existingContent = await fs.readFile(outputFile, "utf8");
  } catch (err) {
    console.error(`Failed to read ${outputFile}: ${err.message}`);
    console.error("Run 'npm run backend:contracts:generate' to create the contract file.");
    process.exit(1);
  }

  const spec = await generateCanonicalOpenApi();
  const generatedContent = JSON.stringify(spec, null, 2) + "\n";

  if (existingContent !== generatedContent) {
    console.error("Contract drift detected!");
    console.error(`${outputFile} does not match the canonical TypeBox schema in packages/contracts/src.`);
    console.error("Please run 'npm run backend:contracts:generate' and commit the updated openapi.json.");
    process.exit(1);
  }

  const paths = Object.keys(spec.paths || {}).length;
  let operations = 0;
  for (const pathItem of Object.values(spec.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
      if (pathItem[method]) operations++;
    }
  }

  console.log(`Contract check passed: ${outputFile} is perfectly in sync (${paths} paths, ${operations} operations).`);
}

main().catch((err) => {
  console.error("Contract check failed:", err);
  process.exit(1);
});
