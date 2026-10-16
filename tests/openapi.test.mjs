import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const module = await import('../extension/openapi.js').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
function parse(text, options) {
  assert.equal(
    typeof module.parseSpecification,
    'function',
    'parseSpecification must be implemented',
  );
  return module.parseSpecification(typeof text === 'string' ? text : JSON.stringify(text), options);
}
const base = { openapi: '3.0.3', info: { title: '防火墙 API', version: '9.2' }, paths: {} };

test('OpenAPI JSON preserves operation inputs, responses, authentication and examples with stable method-path keys', () => {
  const spec = {
    ...base,
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
    },
    paths: {
      '/policies/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: '创建策略',
          operationId: 'createPolicy',
          description: '创建一条规则。',
          parameters: [{ name: 'dryRun', in: 'query', schema: { type: 'boolean' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { action: { type: 'string', enum: ['allow', 'deny'] } },
                },
                example: { action: 'deny' },
              },
            },
          },
          responses: {
            201: {
              description: '策略已创建',
              headers: { 'X-Request-ID': { schema: { type: 'string' } } },
              content: { 'application/json': { example: { id: 'rule-123' } } },
            },
          },
        },
        get: { summary: '获取策略', responses: { 200: { description: '当前策略' } } },
      },
    },
  };
  const result = parse(spec, { sourceURL: 'https://docs.example/openapi.json?revision=9#old' });
  assert.equal(result.title, '防火墙 API');
  assert.equal(result.version, '9.2');
  assert.equal(result.specVersion, '3.0.3');
  assert.deepEqual(result.queue.map((item) => item.key).sort(), [
    'api:GET:/policies/{id}',
    'api:POST:/policies/{id}',
  ]);
  const page = result.pages['api:POST:/policies/{id}'];
  assert.equal(page.status, 'ok');
  assert.equal(new URL(page.url).origin, 'https://docs.example');
  assert.equal(new URL(page.url).search, '?revision=9');
  assert.equal(decodeURIComponent(new URL(page.url).hash.slice(1)), 'api:POST:/policies/{id}');
  assert.deepEqual(page.links, []);
  for (const term of [
    'id',
    'dryRun',
    'requestBody',
    'application/json',
    'allow',
    'deny',
    '201',
    'X-Request-ID',
    'rule-123',
    'X-API-Key',
  ]) {
    assert.ok(page.text.includes(term), term);
    assert.ok(page.markdown.includes(term), term);
    assert.ok(new JSDOM(page.html).window.document.body.textContent.includes(term), term);
  }
  assert.equal(new Set(result.queue.map((item) => item.url)).size, 2);
});

test('Swagger 2 YAML imports inherited parameters, body/form fields, response schema, OAuth and examples offline', () => {
  const result = parse(
    `swagger: '2.0'
info:
  title: 交换机 API
  version: '7.1'
host: api.example
basePath: /v1
schemes: [https]
consumes: [application/json]
produces: [application/json]
security:
  - oauth: [read]
securityDefinitions:
  oauth:
    type: oauth2
    flow: accessCode
    authorizationUrl: https://auth.example/authorize
    tokenUrl: https://auth.example/token
    scopes:
      read: 读取设备
paths:
  /devices:
    parameters:
      - name: tenant
        in: query
        type: string
    post:
      summary: 创建设备
      parameters:
        - name: body
          in: body
          required: true
          schema:
            $ref: '#/definitions/Device'
      responses:
        '200':
          description: 创建完成
          schema:
            $ref: '#/definitions/Device'
          examples:
            application/json:
              name: switch-01
definitions:
  Device:
    type: object
    properties:
      name:
        type: string
`,
    { filename: 'switch.yaml', product: '数据中心交换机', version: '7.1-final' },
  );
  assert.equal(result.title, '数据中心交换机');
  assert.equal(result.version, '7.1-final');
  assert.equal(result.specVersion, '2.0');
  assert.deepEqual(
    result.queue.map((item) => item.key),
    ['api:POST:/devices'],
  );
  const page = result.pages['api:POST:/devices'];
  assert.match(page.url, /^urn:openapi:/);
  for (const term of [
    'tenant',
    'body',
    '#/definitions/Device',
    'switch-01',
    'oauth',
    'accessCode',
    '读取设备',
    'api.example',
    '/v1',
  ])
    assert.ok(page.text.includes(term), term);
});

test('internal refs including cycles, escaped pointer tokens and path items remain linked without recursive expansion', () => {
  const result = parse({
    openapi: '3.1.0',
    info: { title: '循环结构', version: '1' },
    paths: { '/nodes': { $ref: '#/components/pathItems/Nodes' } },
    components: {
      pathItems: {
        Nodes: {
          get: {
            responses: {
              200: {
                description: '节点',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Node~1Tree~0root' } },
                },
              },
            },
          },
        },
      },
      schemas: {
        'Node/Tree~root': {
          description: '父子节点定义',
          type: ['object', 'null'],
          properties: {
            parent: { $ref: '#/components/schemas/Node~1Tree~0root' },
            secret: { type: 'string', writeOnly: true },
          },
        },
      },
    },
  });
  const page = result.pages['api:GET:/nodes'];
  assert.ok(page);
  assert.ok(page.text.includes('父子节点定义'));
  assert.ok(page.text.includes('writeOnly'));
  assert.ok(page.text.includes('#/components/schemas/Node~1Tree~0root'));
  assert.ok(page.text.length < 20000, 'cycles must not expand repeatedly');
  const document = new JSDOM(page.html).window.document;
  const anchors = [...document.querySelectorAll('a[href^="#"]')];
  assert.ok(anchors.length >= 2, 'resolved and cyclic references need navigable local links');
  for (const anchor of anchors)
    assert.ok(
      document.getElementById(decodeURIComponent(anchor.getAttribute('href').slice(1))),
      anchor.outerHTML,
    );
  assert.equal(result.specVersion, '3.1.0');
});

test('external and missing refs are reported without fetching or erasing the referenced operation', () => {
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    throw new Error('no network allowed');
  };
  try {
    const result = parse({
      ...base,
      paths: {
        '/remote': {
          get: {
            responses: {
              200: { $ref: 'https://api.example/definitions.yaml#/Response' },
              400: { $ref: '#/components/responses/Missing' },
            },
          },
        },
        '/unknown': { $ref: './shared.yaml#/Paths' },
      },
    });
    assert.equal(requests, 0);
    assert.equal(result.queue.length, 1);
    const page = result.pages['api:GET:/remote'];
    assert.ok(page.text.includes('https://api.example/definitions.yaml#/Response'));
    assert.ok(
      page.warnings.some(
        (message) => message.includes('外部') && message.includes('definitions.yaml'),
      ),
    );
    assert.ok(result.warnings.some((message) => message.includes('Missing')));
    assert.ok(result.warnings.some((message) => message.includes('shared.yaml')));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('operation overrides inherited parameters and can explicitly disable global authentication', () => {
  const result = parse({
    ...base,
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/status': {
        parameters: [{ name: 'scope', in: 'query', description: 'OLD_INHERITED_PARAM' }],
        get: {
          parameters: [{ name: 'scope', in: 'query', description: 'NEW_OPERATION_PARAM' }],
          security: [],
          responses: { 200: { description: '正常' } },
        },
      },
    },
  });
  const page = result.pages['api:GET:/status'];
  assert.ok(page.text.includes('NEW_OPERATION_PARAM'));
  assert.ok(!page.text.includes('OLD_INHERITED_PARAM'));
  assert.match(page.text, /无需认证|不要求认证/);
});

test('untrusted HTML and Markdown remain inert while code examples preserve their exact data', () => {
  const payload =
    '</pre><script>globalThis.API_IMPORT_EXECUTED=true</script><img src="https://remote.example/track" onerror="alert(1)"><iframe srcdoc="bad"></iframe>';
  const example = { payload: payload + '\n```\n[execute](javascript:alert(1))\n````' };
  const result = parse({
    ...base,
    info: { title: payload, version: '1' },
    paths: {
      '/safe': {
        post: {
          summary: '安全文档',
          description:
            payload + '\n[run](javascript:alert(1))\n![image](https://remote.example/pixel)',
          requestBody: { content: { 'application/json': { example } } },
          responses: { 200: { description: '成功' } },
        },
      },
    },
  });
  const page = result.pages['api:POST:/safe'];
  const doc = new JSDOM(page.html).window.document;
  assert.equal(
    doc.querySelectorAll('script,img,iframe,object,embed,form,input,style,link,meta').length,
    0,
  );
  assert.equal(doc.querySelectorAll('[onclick],[onerror],[srcdoc]').length, 0);
  assert.ok([...doc.querySelectorAll('a')].every((a) => a.getAttribute('href').startsWith('#')));
  assert.ok(
    [...doc.querySelectorAll('pre')].some((pre) => {
      const value = JSON.parse(pre.textContent);
      return value.content?.['application/json']?.example?.payload === example.payload;
    }),
  );
  const outsideFences = page.markdown.replace(/(`{3,})json\n[\s\S]*?\n\1/g, '');
  assert.doesNotMatch(outsideFences, /<script|<img|<iframe|\]\(javascript:|!\[/);
  assert.equal(globalThis.API_IMPORT_EXECUTED, undefined);
});

test('YAML aliases are supported but cyclic aliases and expansion bombs are bounded', () => {
  const result = parse(`openapi: 3.0.3
info: {title: Alias API, version: '1'}
paths:
  /a:
    get:
      responses: &responses
        '200': {description: Available}
  /b:
    get:
      responses: *responses
`);
  assert.equal(result.queue.length, 2);
  assert.ok(result.pages['api:GET:/b'].text.includes('Available'));
  const cyclic = parse(`openapi: 3.0.3
info: {title: Alias cycle, version: '1'}
paths:
  /a:
    get:
      responses:
        '200': &loop
          description: Loop
          x-self: *loop
`);
  assert.ok(cyclic.pages['api:GET:/a'].text.length < 12000);
  assert.ok(cyclic.warnings.some((message) => /循环|别名/.test(message)));
});

test('invalid documents and versions fail with actionable errors; unknown extensions are not operations', () => {
  for (const input of [
    '{bad json',
    'openapi: 3.0.3\nopenapi: 3.1.0',
    '---\nopenapi: 3.0.3\n---\na: b',
    '[]',
    'null',
    JSON.stringify({ openapi: '3.2.0', paths: {} }),
    JSON.stringify({ info: { title: 'No format' } }),
  ]) {
    assert.throws(() => parse(input), /解析|JSON|YAML|OpenAPI|Swagger|格式|版本/);
  }
  const result = parse({
    ...base,
    paths: {
      '/x': {
        parameters: [],
        summary: '路径描述',
        'x-delete': { responses: {} },
        get: { responses: { default: { description: 'fallback' } } },
      },
    },
  });
  assert.deepEqual(
    result.queue.map((item) => item.key),
    ['api:GET:/x'],
  );
});

test('unsafe source addresses are not turned into executable links', () => {
  for (const sourceURL of [
    'javascript:alert(1)',
    'data:text/html,bad',
    'https://user:pass@example.test/openapi.json',
  ]) {
    const result = parse({ ...base, paths: { '/a': { get: { responses: {} } } } }, { sourceURL });
    assert.match(result.pages['api:GET:/a'].url, /^urn:openapi:/);
    assert.ok(result.warnings.some((message) => /来源|地址/.test(message)));
  }
});

test('flow-style YAML is accepted even when the first character is a JSON delimiter', () => {
  const result = parse(
    "{openapi: 3.0.3, info: {title: Flow YAML, version: '1'}, paths: {/health: {get: {responses: {'200': {description: healthy}}}}}}",
  );
  assert.equal(result.title, 'Flow YAML');
  assert.equal(result.pages['api:GET:/health'].status, 'ok');
});

test('OpenAPI 3.1 named schema anchors resolve to a local definition', () => {
  const result = parse({
    openapi: '3.1.1',
    info: { title: 'Anchors', version: '1' },
    paths: {
      '/node': {
        get: {
          responses: {
            200: {
              description: 'node',
              content: { 'application/json': { schema: { $ref: '#node' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          $anchor: 'node',
          type: 'object',
          description: 'NAMED_NODE_DEFINITION',
          properties: { next: { $ref: '#node' } },
        },
      },
    },
  });
  assert.ok(result.pages['api:GET:/node'].text.includes('NAMED_NODE_DEFINITION'));
  assert.ok(!result.warnings.some((message) => message.includes('未找到')));
});

test('alias expansion bombs and excessive input fail explicitly instead of producing a partial archive', () => {
  const bomb = `openapi: 3.0.3
info: {title: Aliases, version: '1'}
a: &a [a,a,a,a,a,a,a,a,a,a]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]
paths: {}
`;
  assert.throws(() => parse(bomb), /别名|alias|Alias|解析/);
  assert.throws(() => parse(' '.repeat(16 * 1024 * 1024 + 1) + '{}'), /16 MiB|过大|超过/);
});

test('contradictory version declarations and object prototype lookups are not silently accepted', () => {
  assert.throws(() => parse({ ...base, swagger: '2.0' }), /版本|格式|冲突/);
  const result = parse(
    '{"openapi":"3.0.3","info":{"title":"Prototype","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"$ref":"#/components/schemas/toString"}}}}},"components":{"schemas":{"__proto__":{"polluted":"forbidden"}}}}',
  );
  assert.equal({}.polluted, undefined);
  assert.ok(result.warnings.some((message) => message.includes('toString')));
});

test('OpenAPI 3.1 references honor schema resource scope instead of resolving against the wrong document', () => {
  const result = parse({
    openapi: '3.1.0',
    info: { title: 'Scoped refs', version: '1' },
    paths: {
      '/scoped': {
        get: {
          responses: {
            200: {
              description: 'scoped',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Local' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Local: {
          $id: 'https://schemas.example/local',
          $defs: { Entry: { description: 'CORRECT_LOCAL_DEFINITION', type: 'string' } },
          properties: { entry: { $ref: '#/$defs/Entry' } },
        },
      },
    },
    $defs: { Entry: { description: 'WRONG_DOCUMENT_DEFINITION', type: 'number' } },
  });
  const page = result.pages['api:GET:/scoped'];
  assert.ok(page.text.includes('CORRECT_LOCAL_DEFINITION'));
  assert.ok(!page.text.includes('WRONG_DOCUMENT_DEFINITION'));
  assert.ok(!result.warnings.some((message) => message.includes('未找到')));
});

test('literal example payload refs remain data rather than generating false unresolved-reference warnings', () => {
  const result = parse({
    ...base,
    paths: {
      '/literal': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                example: { $ref: 'BUSINESS_VALUE_NOT_A_SCHEMA_REF' },
                schema: {
                  type: 'object',
                  properties: { example: { $ref: '#/components/schemas/ExampleProperty' } },
                },
              },
            },
          },
          responses: { default: { $ref: '#/components/responses/Fallback' } },
        },
      },
    },
    components: {
      schemas: { ExampleProperty: { type: 'string', description: 'EXAMPLE_PROPERTY_SCHEMA' } },
      responses: { Fallback: { description: 'DEFAULT_RESPONSE' } },
    },
  });
  const page = result.pages['api:POST:/literal'];
  assert.ok(page.text.includes('BUSINESS_VALUE_NOT_A_SCHEMA_REF'));
  assert.ok(page.text.includes('EXAMPLE_PROPERTY_SCHEMA'));
  assert.ok(page.text.includes('DEFAULT_RESPONSE'));
  assert.ok(
    !result.warnings.some((message) => message.includes('BUSINESS_VALUE_NOT_A_SCHEMA_REF')),
  );
});

test('long operation paths do not amplify every reference anchor into megabytes', () => {
  const definitions = {},
    properties = {};
  for (let index = 0; index < 20; index++) {
    definitions['S' + index] = { type: 'string' };
    properties['v' + index] = { $ref: '#/components/schemas/S' + index };
  }
  const longPath = '/' + 'x'.repeat(40000);
  const result = parse({
    ...base,
    paths: {
      [longPath]: {
        get: {
          responses: {
            200: {
              description: 'Long path',
              content: { 'application/json': { schema: { type: 'object', properties } } },
            },
          },
        },
      },
    },
    components: { schemas: definitions },
  });
  const page = result.pages['api:GET:' + longPath];
  assert.ok(page.markdown.length < 1024 * 1024);
  assert.ok(page.html.length < 1024 * 1024);
});

test('deep flat reference chains stop with a clear importer limit rather than a call-stack overflow', () => {
  const pathItems = {};
  for (let index = 0; index < 5000; index++)
    pathItems['P' + index] =
      index < 4999
        ? { $ref: '#/components/pathItems/P' + (index + 1) }
        : { get: { responses: { 200: { description: 'ok' } } } };
  assert.throws(
    () =>
      parse({
        ...base,
        paths: { '/x': { $ref: '#/components/pathItems/P0' } },
        components: { pathItems },
      }),
    (error) => error.name === 'SpecificationError' && /引用链|超过/.test(error.message),
  );
});

test('schema and Swagger response examples are literal data, while OpenAPI named example refs resolve', () => {
  const modern = parse({
    openapi: '3.1.0',
    info: { title: 'Examples', version: '1' },
    paths: {
      '/x': {
        get: {
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', examples: [{ $ref: 'SCHEMA_EXAMPLE_LITERAL' }] },
                  examples: { named: { $ref: '#/components/examples/ActualExample' } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      examples: { ActualExample: { value: { message: 'EXAMPLE_REFERENCE_RESOLVED' } } },
    },
  });
  assert.ok(modern.pages['api:GET:/x'].text.includes('EXAMPLE_REFERENCE_RESOLVED'));
  assert.ok(!modern.warnings.some((message) => message.includes('SCHEMA_EXAMPLE_LITERAL')));
  const legacy = parse({
    swagger: '2.0',
    info: { title: 'Legacy', version: '1' },
    paths: {
      '/x': {
        get: {
          responses: {
            200: {
              description: 'ok',
              examples: { 'application/json': { $ref: 'SWAGGER_EXAMPLE_LITERAL' } },
            },
          },
        },
      },
    },
  });
  assert.ok(legacy.pages['api:GET:/x'].text.includes('SWAGGER_EXAMPLE_LITERAL'));
  assert.ok(!legacy.warnings.some((message) => message.includes('SWAGGER_EXAMPLE_LITERAL')));
});

test('YAML aliases reused in distinct schema resources retain each occurrence local ref scope', () => {
  const result = parse(`openapi: 3.1.0
info: {title: Scoped aliases, version: '1'}
paths:
  /a:
    get:
      responses:
        '200':
          description: a
          content:
            application/json:
              schema: {$ref: '#/components/schemas/A'}
  /b:
    get:
      responses:
        '200':
          description: b
          content:
            application/json:
              schema: {$ref: '#/components/schemas/B'}
components:
  schemas:
    A:
      $id: https://schemas.example/A
      $defs:
        leaf: {$anchor: leaf, type: string, description: A_ONLY_DEFINITION}
      properties:
        value: &leafReference {$ref: '#leaf'}
    B:
      $id: https://schemas.example/B
      $defs:
        leaf: {$anchor: leaf, type: integer, description: B_ONLY_DEFINITION}
      properties:
        value: *leafReference
`);
  assert.ok(result.pages['api:GET:/a'].text.includes('A_ONLY_DEFINITION'));
  assert.ok(!result.pages['api:GET:/a'].text.includes('B_ONLY_DEFINITION'));
  assert.ok(result.pages['api:GET:/b'].text.includes('B_ONLY_DEFINITION'));
  assert.ok(!result.pages['api:GET:/b'].text.includes('A_ONLY_DEFINITION'));
});

test('default-named fields under conditional schemas and multipart encoding retain their referenced definitions', () => {
  const result = parse({
    openapi: '3.1.0',
    info: { title: 'Conditional upload', version: '1' },
    paths: {
      '/upload': {
        post: {
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  dependentSchemas: { default: { $ref: '#/components/schemas/Conditional' } },
                },
                encoding: {
                  default: { headers: { 'X-Part-Header': { $ref: '#/components/headers/Part' } } },
                },
              },
            },
          },
          responses: { 200: { description: 'ok' } },
        },
      },
    },
    components: {
      schemas: { Conditional: { required: ['other'], description: 'CONDITIONAL_DEFINITION' } },
      headers: { Part: { description: 'ENCODING_HEADER_DEFINITION', schema: { type: 'string' } } },
    },
  });
  const page = result.pages['api:POST:/upload'];
  assert.ok(page.text.includes('CONDITIONAL_DEFINITION'));
  assert.ok(page.text.includes('ENCODING_HEADER_DEFINITION'));
});

test(
  'browser bundle imports YAML under strict CSP without loading external refs or active example HTML',
  { skip: process.env.OPENAPI_BROWSER !== '1' },
  async (t) => {
    const { chromium } = await import('playwright');
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const yaml = `openapi: 3.1.0
info: {title: Offline browser fixture, version: '1'}
paths:
  /nodes:
    get:
      description: '<script>globalThis.untrustedExecuted=true</script><img src="https://invalid.example/track">'
      responses:
        '200':
          description: Node
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Node'}
        '500': {$ref: 'https://invalid.example/external.yaml#/Response'}
components:
  schemas:
    Node:
      type: object
      description: LOCAL_NODE_DEFINITION
      properties:
        next: {$ref: '#/components/schemas/Node'}
`;
    const requests = [],
      errors = [];
    const browser = await chromium.launch({
      ...(process.env.MANUALDOCK_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.MANUALDOCK_CHROMIUM_EXECUTABLE }
        : { channel: 'chromium' }),
      headless: true,
    });
    try {
      const context = await browser.newContext();
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.href);
        if (url.origin !== 'https://openapi-fixture.test') {
          await route.abort();
          return;
        }
        if (url.pathname === '/') {
          await route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; img-src data:"><link rel="icon" href="data:,"></head><body><main id="render"></main><script type="module" src="/fixture.mjs"></script></body></html>',
          });
        } else if (url.pathname === '/fixture.mjs') {
          await route.fulfill({
            contentType: 'text/javascript',
            body: `import { parseSpecification } from '/extension/openapi.js'; const result=parseSpecification(${JSON.stringify(yaml)},{sourceURL:'https://docs.example/spec.yaml'}); document.querySelector('#render').innerHTML=result.pages['api:GET:/nodes'].html; globalThis.fixtureResult=result;`,
          });
        } else if (['/extension/openapi.js', '/extension/vendor/yaml.js'].includes(url.pathname)) {
          await route.fulfill({
            contentType: 'text/javascript',
            body: await readFile(root + url.pathname, 'utf8'),
          });
        } else await route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('https://openapi-fixture.test/');
      await page.waitForFunction(() => !!globalThis.fixtureResult);
      const result = await page.evaluate(() => ({
        keys: fixtureResult.queue.map((item) => item.key),
        specVersion: fixtureResult.specVersion,
        localDefinition: document.body.textContent.includes('LOCAL_NODE_DEFINITION'),
        dangerousElements: document.querySelectorAll('#render script,#render img,#render iframe')
          .length,
        execution: globalThis.untrustedExecuted === true,
        linksResolve: [...document.querySelectorAll('#render a')].every(
          (a) => !!document.getElementById(a.getAttribute('href').slice(1)),
        ),
        externalRefReported: fixtureResult.warnings.some((w) => w.includes('external.yaml')),
      }));
      assert.deepEqual(result.keys, ['api:GET:/nodes']);
      assert.equal(result.specVersion, '3.1.0');
      assert.equal(result.localDefinition, true);
      assert.equal(result.dangerousElements, 0);
      assert.equal(result.execution, false);
      assert.equal(result.linksResolve, true);
      assert.equal(result.externalRefReported, true);
      assert.deepEqual(errors, []);
      assert.ok(requests.every((url) => url.startsWith('https://openapi-fixture.test/')));
      assert.equal(requests.length, 4);
      const report = {
        passed: true,
        testedAt: new Date().toISOString(),
        isolatedChromium: true,
        userChromeNotUsed: true,
        strictCSP: true,
        allRequestsInterceptedLocally: true,
        requests,
        errors,
        ...result,
      };
      t.diagnostic(JSON.stringify(report));
    } finally {
      await browser.close();
    }
  },
);
