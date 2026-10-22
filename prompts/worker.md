---
name: worker
description: Describe what this custom agent does and when to use it.
argument-hint: The inputs this agent expects, e.g., "a task to implement" or "a question to answer".
# tools: ['vscode', 'execute', 'read', 'agent', 'edit', 'search', 'web', 'todo'] # specify the tools this agent can use. If not set, all enabled tools are allowed.
---

<!-- Tip: Use /create-agent in chat to generate content with agent assistance -->

🧭 Working Agreement (18/03/2026 - Backend)

Purpose: to keep all backend apps consistent, maintainable, and predictable while giving teams room to decide how they implement details.

Applies to: all main FastAPI + SQLAlchemy apps
Legacy: "best effort" — no rewrites unless the code is actively touched.
_TOC_
🧱 Architecture
Must

Follow the Service + Repository pattern.

Routes and repositories stay thin.
All business logic lives in the service layer.


Repositories must never call commit(), rollback(), or close() directly.
One transaction per request; the session dependency handles commit/rollback.
Use SQLAlchemy 2.x syntax and typed models.
Define proper database constraints to enforce data integrity:

Foreign keys for relational consistency.
Unique constraints where applicable (e.g. identifiers, codes, names).
Enum types or validated string columns for categorical fields.
CHECK constraints when logical ranges apply (e.g. percentages, ratios).


Constraints are part of the schema and must be included in migrations.

# Example: request-scoped transaction
from typing import Iterator
from sqlalchemy.orm import Session
from .db import SessionLocal

def get_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    else:
        session.commit()
    finally:
        session.close()
Should

Services encapsulate domain rules; repositories and routes are dumb and focus only on persistence.
Separate external I/O (API calls, S3, etc.) into gateway/helper classes.

May

In case of a view part of the application where we need to return certain output in different formats (e.g. one /rating and /rating/xlsx) you may have the router handle the conversion to xlsx or json

📁 Code Layout (Co-location)
Must

Each (sub)module (or "app") contains: models/, schemas/, repo/, services/, router.py, tests/.
If you have cross-domain or infrastructure-level tests (e.g., auth middleware, metrics, health checks), they may live under a shared tests/ folder.
Domain-specific or API route tests belong next to their module.
Keep migrations in a dedicated migrations/ folder (Flyway/Alembic).

Example folder layout
Top-level structure

core/ – app-wide setup and infrastructure (FastAPI init, middleware, celery)
common/ – shared utilities, base models, and mixins
modules/ – feature-specific domains (each self-contained mini-app)
migrations/ – Flyway or Alembic migration scripts
tests/ – optional cross-domain or integration tests (e.g., health check, auth)

api
  app-name/
    core/
      settings.py
      app.py
      local.py  # or debug.py
      worker.py

    common/
      models/
        base.py
      mixins/
        timestamp_mixin.py
      utils/
        math_helpers.py

    modules/
      entity/
        models.py   # or models/* or entity_models.py
        repository.py  # or repository/* or entity_repository.py
        service.py # Read comment below for this file 
        router.py
        tests/
          test_routes/
            test_entity_create.py
            test_entity_update.py

    tests/
      test_healthcheck.py
      test_worker/
        test_worker.py
      e2e/
        test_e2e_entity_rating_flow.py

migrations/
  V1__init.sql
  V2__add_rating_table.sql
  U2__add_rating_table.sql
service.py file
This file should be the entry point for any other module wanting to use something from this module.
As an example: If a second module wants to get all the entities, shouldn't go to Repository or Model, but to Service with something like EntityService.get_all_entities()
🚨 Error Handling
Must

Always raise. Never silently swallow exceptions.
HTTP responses are mapped through exception handlers or middleware.
When middleware is in place, it is no longer needed to return HTTP exceptions, this should be handled by the middleware
App config is handled in app.py and settings.py. Please don't deviate from this naming as infra checks for these files.

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from zanders.fastapi_utils import add_exception_to_telemetry

def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ValueError)
    async def value_error_handler(_: Request, exc: ValueError):
        add_exception_to_telemetry(str(exc))
        return JSONResponse(status_code=400, content={"error": str(exc)})
Should

Include human-readable messages in JSON error payloads.

def build_single_exception_json_response(
    status_code: HTTPStatus,
    link: str,
    exception_type: ErrorType,
    title: str,
    detail: str | None = None,
    relevant_fields: list[str] | None = None,  # used with sqlalchemy exceptions
    raw_pydantic_errors: Sequence[Any] | None = None,  # used with pydantic validation errors
) -> JSONResponse:
    """Builds a standardized JSON response for exceptions."""
    return JSONResponse(
        content=ErrorWrapperSchema(
            status_code=status_code,
            link=link,
            errors=[
                ErrorSchema(
                    exception_type=exception_type,
                    title=title,
                    detail=detail,
                    relevant_fields=relevant_fields,
                    raw_pydantic_errors=raw_pydantic_errors,
                )
            ],
        ).dict(),
        status_code=status_code,
    )
🧪 Testing
Principles

Integration tests are the default for endpoints.
Unit tests complement them by covering complex business logic in isolation.

Must

Each endpoint has at least one integration test covering the happy path.

Failure cases are encouraged but not required for all endpoints, especially in early-stage or fast iteration work.


Tests hit real DB (no mocks for internal layers).
Tests co-located with code.
All tests should always run successfully on PostgreSQL and CI should always run postgres.
Test setup scripts must not contain SQL schema code, e.g. to set up types in the database. Always use the correct SQLAlchemy types in model definitions so test database setup is easy, clean and doesn't need additional steps. (See "May" section for an exception.)
Prefer integration over heavy-mock unit tests. Good / bad test example:

# ✅ GOOD: Integration-style unit test using the real DB + factory.
# - Validates the full request → service → repo → DB flow.
# - Catches schema issues, validation errors, SQL problems, etc.

class TestUpdateEntity:
    def test_update_entity_happy_path(
        self, client: TestClient, session: Session, entity_factory: EntityFactory
    ):
        # Arrange
        entity = entity_factory.create(name="Acme Holdings")
        payload = {"name": "Nova Capital Partners"}

        # Act
        res = client.put(f"/entities/{entity.uuid}", json=payload)

        # Assert
        assert res.status_code == 200
        assert res.json()["name"] == "Nova Capital Partners"

        # Verify persistence — ensures repo/service/db logic is correct
        updated = session.scalar(
            select(Entity).where(Entity.uuid == entity.uuid)
        )
        assert updated.name == "Nova Capital Partners"

# ❌ BAD: Over-mocked "unit test" that only checks internal calls.
# - This doesn't validate behavior, only implementation details.
# - Refactors break it even when the app still works.
# - The test would PASS even if the update logic were completely wrong.

def test_update_entity_with_repo_mock(client: TestClient):
    mock_repo = MagicMock()

    # Override the dependency used in the router
    client.app.dependency_overrides[EntityRepoDep] = lambda: mock_repo

    payload = {"name": "Nova Capital Partners"}

    res = client.put("/entities/some-uuid", json=payload)

    # Asserting that a mock was called does not verify real correctness.
    mock_repo.update.assert_called_once_with(
        uuid="some-uuid",
        data=payload,
    )

    assert res.status_code == 200  # Might still be wrong in real app

    # Cleanup
    client.app.dependency_overrides.clear()
Example test setup:
@pytest.fixture()
def db_session() -> Generator[Session, None, None]:
    """
    Create a database session for testing.
    - Each test runs in its own transaction.
    - Rolls back automatically after test.
    - Works for both PostgreSQL and SQLite (in-memory).
    """
    connection = engine.connect()
    session = Session(bind=connection)
    connection.begin()

    if settings.is_sqlite_backend():
        # Enforce foreign key constraints in SQLite
        connection.execute(text("PRAGMA foreign_keys=ON"))

    try:
        yield session
    finally:
        session.rollback()  # rollback before closing for isolation
        session.close()
        connection.close()
Should

Mock only external dependencies (e.g., HTTP, S3, etc.). In the case of a http client, we should use a mock library like respx, pytest-httpx or requets-mock, avoiding mocking the client itself and mocking only the http reponse
It should be possible to run the app locally and run pytest on the exact same code base at the same time. Therefore any (local) settings for these different runtimes belong in different scoped .env files, e.g. .env.dev and .env.test. No code changes should be necessary to run and pytest an app. App and test setup should ingest the correctly scoped .env file.
When you are working on a bug fix, it is encouraged to isolate the bug in a test in the same MR where applicable to cover regression scenarios.

May

You are welcome to speed up local development by using SQLite (in-memory):
One test class per endpoint.
Factories/fixtures; snapshot testing for responses.
As an exception to "no SQL execution in test setup scripts", you may seed the database with test data using SQL scripts; use an SQL-file with seed data and insert that into the database, e.g.

@pytest.fixture(scope="function")  # or module, or session
def seeded_engine(engine):
    seed = Path("tests/seed.sql").read_text()
    with engine.begin() as conn:
        conn.execute(text(seed))
    return engine
🔒 Security & Observability
Must

Input validation (Pydantic) on all routes.

Should

All the endpoints need a response type hint or response_model or both. This ensures correct OpenAPI schema generation and response validation.

@router.post("", response_model=UserResponse)
def create_user(payload: UserCreate, service: UserServiceDep):
    return service.create_user(payload)
or
@router.post("")
def create_user(payload: UserCreate, service: UserServiceDep) -> UserResponse:
    return service.create_user(payload)
⚙️ CI / Quality
Must

CI runs linting, type checks, and tests:

ruff check .
ruff format
mypy .
pytest


All PRs must pass these checks before merging.
These checks already run in the existing CI pipelines.
Mypy rules cannot be lifted without explicitly explaining in an ADR (legacy projects excluded)

✅ Definition of Done

Service + Repository respected.
One transaction per request; repos don't commit.
Exceptions mapped via handlers; none swallowed.
Integration test (happy + failure).
CI green - ruff, mypy, pytest.
No duplicated logic/config.
Migration included if schema changed.

⚖️ Governance

Must: follow this agreement for new code.
Should: ADR for any deviation (short, should take 10 minutes).
May: review/adjust rules quarterly.
Owner: Backend Leads / Tech Leadership
Maintainer: Vincent van Leeuwen (v.van.leeuwen@zandersgroup.com)


🧭 REST Best Practices
To keep our APIs scalable and, most important, readable, please adhere to standard REST best practices when creating new routes and use a plural namespace.
This implies the following structure (transactions used as example namespace):

GET /transactions - Get a list of transactions
GET /transactions/<uuid> - Retrieves a specific transaction with id uuid
POST /transactions - Creates a transaction
PUT /transactions/<uuid> - Updates transaction with id uuid
PATCH /transactions/<uuid> - Partially updates a transaction with id uuid
DELETE /transactions/<uuid> - Deletes transaction with id uuid

When dealing with foreign keys or nested relations, please help other developers by nesting in a way that's easy to understand for the reader. For example, any events that would be related to a transaction would be nested as follows:

GET /transactions/<uuid>/events - Get a list of events for transaction with id uuid
GET /transactions/<uuid>/events/<uuid> - Retrieves a specific event
POST /transactions/<uuid>/events - Creates an event related to a transaction
PUT /transactions/<uuid>/events/<uuid> - Updates event with id uuid for transaction
PATCH /transactions/<uuid>/events/<uuid> - Partially updates a event with id uuid for transaction
DELETE /transactions/<uuid>/events/<uuid> - Deletes event with id uuid for a given transaction

For full reference including the above and more complicated examples & use cases:
https://www.vinaysahni.com/best-practices-for-a-pragmatic-restful-api

Note: import only on top of file, not inside functions or classes.



🧭 Working Agreement (18/03/2026 - Frontend)

Purpose: to keep all frontend apps consistent, maintainable, and predictable while giving teams room to decide how they implement details.
Status: living document. We will iterate on this agreement as we learn from real usage.
If a rule causes friction or doesn’t scale, propose a change via MR (with rationale + example).

Applies to: all main React / Vite apps
Legacy: "best effort" — no rewrites unless the code is actively touched.

🧱 Architecture
Must

Use TypeScript everywhere.

Reduce usage of any and as as much as possible.
Prefer unknown with proper narrowing.


Use React Query for server/remote state.
Use MUI for UI components/styling.
Use React Hook Form for forms.

Should

Avoid global state unless there is a clear, documented need.

If needed, prefer React Query cache + URL state before introducing a global store.


Keep business logic out of UI components:

Put data/transform logic in hooks (useX) or small lib/ helpers.



May

Introduce a global state solution (e.g. Zustand / native context) for truly app-wide UI state only when React Query + local state are insufficient.
For complex forms, introduce form-specific helpers (custom resolvers, field adapters) as long as the form remains maintainable.


📁 Code Layout (Co-location)

Goal: keep code easy to navigate, reduce indirection, and avoid premature abstraction.

Must

api/__generated__/: Kubb generated code only (oas, queries, schemas, types). Never manually edit.
core/: app bootstrap only

providers/
router.ts
AppLayout.tsx
App.tsx
locales/: i18n resources (e.g. en-common, en-model, en-app)


common/: shared utilities used by many modules

components/: top-level shared components
hooks/: top-level shared hooks
lib/: wrappers + shared utilities


modules/: feature modules. Each module owns:

routes.ts — integration point (nested into top-level router)
One sub-feature folder per route or scoped UI/domain unit (e.g. workflow-list/, workflow-detail/, parameter-group-list/)
Optionally a module-level types.ts or types/ — only for types/schemas shared across multiple features within the module (also serves as the Kubb re-export boundary)


Co-locate by default: components, queries, hooks, types, and tests must live inside the feature folder that uses them.
Do not place files at module root unless they are genuinely shared by multiple features within that module.
Do not use a generic pages/ folder. Each route gets its own feature folder with a page.tsx.
@types/:

i18next.d.ts: type overrides / extensions


common/** must never import from modules/**.

Should

Follow a "promote when reused" rule:

Used in 1 feature → keep it inside that feature folder
Used in multiple features within the same module → promote to module root
Used across modules → promote to common/ or common/domains/<domain>/


Avoid top-level components/, queries/, hooks/, types/ inside a module unless those files are truly shared across features.
Keep feature folders small and focused.
Prefer feature boundaries:

Avoid direct imports between feature modules.
If something is reused across modules, first extract it into:

common/ (generic reusable code), or
common/domains/<domain>/... (domain-specific shared code)


Only if extraction is not sensible, allow cross-module imports via a clear public entrypoint (no deep imports).


Prefer re-exports (index.ts) within a module to keep imports readable and stable.

Where does this file go? (quick checklist)



Scenario
Location




Only used by one feature
Inside that feature's folder


Used by multiple features in the same module
Module root


Used by multiple modules
common/ or common/domains/<domain>/


Kubb re-export / shared schema
Module-level types.ts



Example (preferred)
modules/workflows/
  routes.ts
  types.ts              ← only if types are shared across features

  workflow-list/
    page.tsx
    page.test.tsx
    queries.ts
    types.ts
    components/

  workflow-detail/
    page.tsx
    page.test.tsx
    queries.ts
    types.ts
    hooks/
    components/
Anti-pattern (avoid)
modules/workflows/
  components/           ← ❌ module-level bucket
  queries/              ← ❌ module-level bucket
  hooks/                ← ❌ module-level bucket
  types/                ← ❌ module-level bucket (unless truly shared)
  pages/                ← ❌ generic pages folder

🗺️ Modules, Routes & Pages
Must

Each route or scoped UI/domain unit gets its own feature folder directly under the module (e.g. workflow-list/, workflow-detail/).

Each feature folder contains page.tsx and co-located queries.ts, types.ts, components/, hooks/ as needed.
Tests co-locate next to the file they test (e.g. page.test.tsx).


Modules integrate with the app via modules/<feature>/routes.ts.

Routes are composed in core/router.ts (or core/router/*).


Route-level components use page.tsx as the filename. The exported component should be descriptively named (e.g. WorkflowListPage).

Pages are for composition + wiring (data fetching, layout, form wiring), not for reuse as generic building blocks.



// /modules/workflows/routes.tsx
import { WorkflowListPage } from "~/modules/workflows/workflow-list/page"
import { WorkflowDetailPage } from "~/modules/workflows/workflow-detail/page"

export const workflowRoutes = (
  <Route element={<SideMenuLayout sideMenuItems={appNavItems} title="XYZ Workflows" />}>
    <Route index element={<WorkflowListPage />} />
    <Route path="workflows/:workflowUuid" element={<WorkflowDetailPage />} />
  </Route>
)

// /core/router.tsx
import { workflowRoutes } from "~/modules/workflows/routes"

export function RootRouter() {
  return (
    <Routes>
      <Route element={<AuthLayout />}>{workflowRoutes}</Route>
      {/* other routes */}
    </Routes>
  )
}
Should

Prefer module boundaries:

Avoid direct imports between feature modules.
If something is reused across modules, first extract it into:

common/ (generic reusable code), or
common/domains/<domain>/... (domain-specific shared code)




Keep route definitions close to the module:

Route configs, loaders, and route-level query wiring belong in the module, not in core/.



May

Add extra folders inside a feature folder or module when helpful (e.g. adapters/, mappers/, constants/, utils/), as long as ownership stays inside the module and the structure remains predictable.


🔌 API (Kubb) & Types
Must

All remote data must be treated as untrusted (unknown).
Zod schemas generated by Kubb must be used to runtime-validate API responses.
App/feature code (components/, hooks/, routes/, queries/) must not import from api/** (generated output).
Generated API types/schemas may only be referenced inside a type boundary:

Feature-level: modules/<module>/<feature>/types.ts (feature-specific types)
Module-level: modules/<module>/types.ts (shared across features within the module)


Feature code must import types/schemas from its own type boundary or the module boundary, not from generated sources.
Runtime validation must be consistent:

Use safeParse
Log/report the validation error
Throw a shared error type (React Query handles it uniformly)
In non-production environments, throw a shared error type so issues surface immediately during development
In production, log the error but do not throw — fail gracefully to avoid disrupting users over validation edge cases



Should

Prefer generating Kubb output grouped by path rather than by tags.

Path-based grouping scales better in large APIs because it mirrors the API structure more closely.
It avoids a single, cluttered base folder of schemas/types that tends to happen with tag-based grouping.



Example: module-owned types + schema boundary (modules/workflow/types.ts)
import { z } from "zod"
import { workflowOverviewSchema as kubbWorkflowOverviewSchema } from "~/api/__generated__/schemas/workflowOverviewSchema"

// Rename Kubb exports at the module boundary (keep generated naming out of feature code).
export const workflowOverviewSchema = kubbWorkflowOverviewSchema
export type WorkflowOverview = z.infer<typeof workflowOverviewSchema>

🚨 Error Handling

Goal: consistent UX and a single place to plug in telemetry later. We prefer predictable “fail closed” behavior over silent corruption.

Must

Handle async errors consistently:

React Query errors must surface through the query error state (no swallowed errors).
Zod validation failures must:

be logged (for now: console.error)
throw a shared error type in non-production environments (so React Query treats it uniformly and issues surface during development)
in production: log only — do not throw




Use a single shared helper for API response validation (e.g. common/lib/parseApiResponse.ts).
Screens must have predictable states:

loading
error
empty (where applicable)



Should

For user-facing errors:

Prefer inline error states inside the page/component over full-page “crash” screens.
Use a consistent error component (e.g. common/components/ErrorState).



May

Add telemetry integration later (OpenTelemetry/Sentry/etc.) by replacing the logger in the shared helper.
Introduce an app-level error boundary for unexpected render-time errors (not for data validation errors).

Example: shared validation hook point
/**
 * Validates an API response against a Zod schema.
 * Logs validation errors and throws an ApiValidationError on failure.
 */
export function parseApiResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)

  if (!result.success) {
    // TODO: Send to opentelemetry or similar instead of just logging to console
    console.error('[API Validation Error]', result.error.issues, { data })

    if (import.meta.env.MODE !== 'production') {
      throw new ApiValidationError('API response validation failed', result.error.issues)
    }

    // In production, fail gracefully — return the raw data and let the UI handle missing fields.
    return data as T
  }

  return result.data
}

🌐 API Fetching
Must

Never pass a headers object directly to fetchApi. Use fetchAndParse or fetchAndParseFormData from common/api/client.ts instead — they guarantee the CSRF header (X-Zanders-Inside-CSRF-Header) is always present.
The fetchApi package uses object spread ({ headers: defaults, ...options }), so passing headers in options replaces all defaults, silently dropping the CSRF header. This causes 403 / 401 errors in deployed environments (Traefik rejects mutating requests without the CSRF header).
If you need custom headers, pass them via fetchAndParse options — it merges them safely on top of the required headers.


🧱 CI / Codegen Sync

Goal: prevent drift between backend implementation, OpenAPI specs, and frontend generated clients/types.

Must

CI must enforce that generated artifacts are up-to-date:

Backend OpenAPI spec generation must match the current backend implementation (no diff).
Frontend Kubb output must be in sync with the OpenAPI specs (no diff).


MRs must not be mergeable when these checks fail.

Should

Developers should run the same generators locally before pushing changes:

Backend: uv run -m appxyz.core.generate_openapi (in api/)
Frontend: pnpm generate (in client/)


Provide IDE run configurations (VSCode/IntelliJ) for both generators to keep the workflow easy.

May

Keep the generator jobs runnable manually (allow-failure) for experimentation, but not as a substitute for merge gating.

Reference (GitLab CI jobs)
python:test:generate:
  stage: test
  interruptible: true
  image: $CI_REGISTRY_IMAGE/api:$CI_COMMIT_SHORT_SHA
  needs: [python:build]
  script:
    - which uv || pip install uv
    - uv --directory=api run -m appxyz.core.generate_openapi
    - git diff --exit-code || (echo 'Generated code is not up to date. Please run `uv run -m appxyz.core.generate_openapi` in the `api` directory (or the provided launch/run config in VSCode/IntelliJ) and commit the changes.' && exit 1)
  rules:
    - if: $CI_COMMIT_TAG || $CI_COMMIT_BRANCH =~ /^master|dev$/
      when: on_success
      allow_failure: false
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - api/**/*
        - .gitlab-ci.yml
        - openapi.json
        - openapi.*.json
      when: on_success
      allow_failure: false
    - when: manual
      allow_failure: true

web:test:generate:
  stage: test
  interruptible: true
  image: ${CI_REGISTRY_IMAGE}/web/install:$CI_COMMIT_SHORT_SHA
  needs: [web:install]
  variables:
    KUBERNETES_MEMORY_LIMIT: 4Gi
  script:
    - ln -s /usr/src/app/node_modules client/node_modules
    - pnpm --dir=client run generate
    - git diff --exit-code || (echo 'Generated code is not up to date. Please run `pnpm generate` in the `client` directory (or the provided launch/run config in VSCode/IntelliJ) and commit the changes.' && exit 1)
  rules:
    - if: $CI_COMMIT_TAG || $CI_COMMIT_BRANCH =~ /^master|dev$/
      when: on_success
      allow_failure: false
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - client/**/*
        - .gitlab-ci.yml
        - openapi.json
        - openapi.*.json
      when: on_success
      allow_failure: false
    - when: manual
      allow_failure: true

🧰 Code Style & Tooling (Biome)
Must

Biome is the single source of truth for formatting + linting.
CI must run Biome checks and fail on violations.
Generated code (**/__generated__/**) must be excluded from strict style rules that are incompatible with codegen.

Should

Keep Biome overrides minimal.

Prefer fixing code at the source (config/code) over disabling rules broadly.


Restrict relaxed rules to generated folders only.

Avoid turning off rules globally because of generated output.



May

Temporarily disable additional rules (with a TODO) if they block delivery, but they should be revisited and removed.


🧪 Testing

Goal: maximize confidence per hour spent. Most business logic lives in the backend, so frontend testing focuses on critical user flows and runtime safety.

Must

New or changed code must not reduce overall confidence:

App builds, lints, and typechecks in CI.
Critical bugs should get a regression test when practical.


Test shared utilities in common/lib when they contain non-trivial logic (pure functions).
For React Query hooks that validate API data:

Validation must exist (Zod).
Failures must be handled consistently (shared helper).


Avoid snapshot tests for UI rendering as a default.

Should

Co-locate tests next to the file they test (e.g. page.test.tsx alongside page.tsx, queries.test.ts alongside queries.ts). Do not use a separate __tests__/ folder.
Prefer a small number of integration-style tests over many unit tests:

React Testing Library + MSW (mock server) for "feature works end-to-end in the browser DOM" without real backend.
Focus on "happy path + one failure path" for critical screens (login, key workflows, save forms).


Add tests when:

The feature is business-critical
The UI contains complex conditional logic
There was a production bug (regression coverage)


Skip tests for small UI-only changes (spacing, copy) if risk is low.
Keep tests stable:

Assert on user-visible behavior (text, roles, navigation), not implementation details.
Avoid asserting exact markup structure.



May

Add E2E tests (Playwright/Cypress) for only the most critical flows:


🏷️ Naming & Imports
Must

Use ~/ path alias for internal imports (no long relative import chains).
Route-level components use page.tsx as the filename. The exported component is descriptively named (e.g. WorkflowListPage).

Should

Prefer consistent naming patterns:

Hooks: useX
Components: XyzCard, XyzDialog, XyzForm


Avoid deep imports across boundaries:

Import from module public entry points (types.ts, routes, index.ts) rather than deep file paths.



May

Use barrel files (index.ts) where they improve readability, but avoid over-barreling (don’t hide important structure).


✅ Definition of Done
Must

CI is green:

Biome (format + lint)
TypeScript typecheck
Codegen sync checks (OpenAPI + Kubb) for any type that's backend generated


Remote data handling follows the agreement:

API responses validated with module-owned Zod schemas
No direct imports from kubb generated code (api/**) outside module type boundaries


No duplicated logic/config introduced (prefer reuse via common/ or common/domains/<domain>)

Should

Skip tests for low-risk UI-only changes (copy/spacing) if confidence is high and impact is low.
Add/adjust tests when risk is non-trivial:

Business-critical flows
Complex conditional UI logic
Regression after a production bug


Ensure new routes/pages follow routing conventions (feature folder with page.tsx, module boundary)
Keep naming and imports consistent (~/ alias, avoid deep boundary breaks)

Never do local imports inside functions, only on top of the file.
IMPORTANT!!!: NEVER PUSH!
