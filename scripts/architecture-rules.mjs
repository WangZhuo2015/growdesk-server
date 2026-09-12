import ts from "typescript";
import path from "node:path";

function isPackage(specifier, prefix) {
  return specifier === prefix || specifier.startsWith(`${prefix}/`);
}

function importSpecifiers(source) {
  const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  let containsAny = false;
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) specifiers.push(argument.text);
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) containsAny = true;
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { specifiers, containsAny };
}

function relativeCrosses(relativeFile, specifier, target) {
  if (!specifier.startsWith(".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), specifier));
  return resolved === target || resolved.startsWith(`${target}/`);
}

function crossesAny(relativeFile, specifier, targets) {
  return targets.some((target) => relativeCrosses(relativeFile, specifier, target));
}

function forbiddenForLayer(layer, specifier) {
  const infrastructure = ["fastify", "@fastify", "@prisma", "prisma", "bullmq", "ioredis", "redis", "pg"];
  if (layer === "domain") {
    return infrastructure.some((prefix) => isPackage(specifier, prefix)) ||
      isPackage(specifier, "@growdesk/database") || isPackage(specifier, "@growdesk/adapters") ||
      isPackage(specifier, "@growdesk/contracts") || isPackage(specifier, "@growdesk/api");
  }
  if (layer === "contracts") {
    return infrastructure.some((prefix) => isPackage(specifier, prefix)) ||
      ["@growdesk/domain", "@growdesk/database", "@growdesk/adapters", "@growdesk/api"].some((prefix) => isPackage(specifier, prefix));
  }
  if (layer === "database") {
    return ["@growdesk/adapters", "@growdesk/contracts", "@growdesk/api", "@growdesk/worker", "@growdesk/scheduler"].some((prefix) => isPackage(specifier, prefix));
  }
  if (layer === "adapters") {
    return ["@growdesk/database", "@growdesk/contracts", "@growdesk/api", "@growdesk/worker", "@growdesk/scheduler"].some((prefix) => isPackage(specifier, prefix));
  }
  return false;
}

export function findArchitectureViolations(relativeFile, source) {
  const result = [];
  const layerMatch = /^packages\/(domain|contracts|database|adapters)\/src\//.exec(relativeFile);
  const layer = layerMatch?.[1];
  const { specifiers, containsAny } = importSpecifiers(source);
  if (layer) {
    for (const specifier of specifiers) {
      if (forbiddenForLayer(layer, specifier)) {
        result.push(`${relativeFile}: ${layer} imports forbidden module ${specifier}`);
      }
      const relativeTargets = {
        domain: ["packages/database/src", "packages/adapters/src", "packages/contracts/src", "apps"],
        contracts: ["packages/domain/src", "packages/database/src", "packages/adapters/src", "apps"],
        database: ["packages/adapters/src", "packages/contracts/src", "apps"],
        adapters: ["packages/database/src", "packages/contracts/src", "apps"],
      }[layer];
      if (relativeTargets && crossesAny(relativeFile, specifier, relativeTargets)) {
        result.push(`${relativeFile}: ${layer} reaches another layer through ${specifier}`);
      }
    }
  }
  if (containsAny) result.push(`${relativeFile}: unbounded any crosses a package boundary`);
  return result;
}
