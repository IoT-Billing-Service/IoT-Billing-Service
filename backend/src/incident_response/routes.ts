/**
 * Incident Response Admin API Routes
 *
 * Provides REST endpoints for managing incident response:
 * - GET /api/admin/incidents — List incident detection history
 * - GET /api/admin/incidents/:id — Get incident details
 * - POST /api/admin/incidents — Manually trigger an incident
 * - GET /api/admin/runbooks — List available runbooks
 * - GET /api/admin/runbooks/:name — Get runbook definition
 * - POST /api/admin/runbooks/:name/execute — Execute a runbook
 * - GET /api/admin/executions — List runbook execution history
 * - GET /api/admin/executions/:id — Get execution details
 * - GET /api/admin/incident-response/status — Get module status
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getEnv } from '../config/env.js';
import type { DetectedIncident, IncidentSeverity, RunbookDefinition } from './types.js';
import type { RunbookEngine } from './runbook_engine.js';
import type { IncidentDetector } from './incident_detector.js';
import { BUILTIN_RUNBOOKS, BUILTIN_RUNBOOKS_BY_NAME } from './runbook_definitions.js';

// ---------------------------------------------------------------------------
// Auth helper (reuses the same pattern as admin.ts)
// ---------------------------------------------------------------------------

function verifyAdminAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const env = getEnv();
  const authHeader = request.headers['x-admin-key'] as string | undefined;

  if (env.ADMIN_SECRET_KEY == null || env.ADMIN_SECRET_KEY === '') {
    void reply.status(503).send({
      error: 'Admin secret key not configured',
      message: 'Set ADMIN_SECRET_KEY environment variable to enable admin endpoints',
    });
    return false;
  }

  if (authHeader == null || authHeader === '' || authHeader !== env.ADMIN_SECRET_KEY) {
    void reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing X-Admin-Key header',
    });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerIncidentResponseRoutes(
  app: FastifyInstance,
  engine: RunbookEngine,
  detector: IncidentDetector,
): void {
  /**
   * GET /api/admin/incident-response/status
   * Returns the current status of the incident response module.
   */
  app.get(
    '/api/admin/incident-response/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      return reply.send({
        module: 'incident_response',
        version: '1.0.0',
        detector: {
          enabled: true,
          rules: detector.getRuleCount(),
          totalDetections: detector.getTotalDetections(),
          totalErrors: detector.getTotalErrors(),
        },
        engine: {
          activeExecutions: engine.getActiveExecutionCount(),
          totalExecutions: engine.getExecutionHistory().length,
        },
        runbooks: {
          available: BUILTIN_RUNBOOKS.length,
          names: BUILTIN_RUNBOOKS.map((r) => r.name),
        },
        timestamp: Date.now(),
      });
    },
  );

  /**
   * GET /api/admin/runbooks
   * Lists all available runbook definitions.
   */
  app.get('/api/admin/runbooks', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAdminAuth(request, reply)) return;

    return reply.send({
      runbooks: BUILTIN_RUNBOOKS.map((r) => ({
        name: r.name,
        description: r.description,
        version: r.version,
        appliesTo: r.appliesTo,
        severities: r.severities,
        stepCount: r.steps.length,
        tags: r.tags,
      })),
    });
  });

  /**
   * GET /api/admin/runbooks/:name
   * Returns the full definition of a specific runbook.
   */
  app.get<{ Params: { name: string } }>(
    '/api/admin/runbooks/:name',
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { name } = request.params;
      const runbook = BUILTIN_RUNBOOKS_BY_NAME[name ?? ''];

      if (runbook === undefined) {
        return reply.status(404).send({
          error: 'Runbook not found',
          message: `No runbook found with name: ${name}`,
        });
      }

      return reply.send(runbook);
    },
  );

  /**
   * POST /api/admin/runbooks/:name/execute
   * Manually execute a runbook for a given incident.
   */
  app.post<{
    Params: { name: string };
    Body: {
      title: string;
      description: string;
      severity: IncidentSeverity;
      source?: string;
      context?: Record<string, unknown>;
    };
  }>(
    '/api/admin/runbooks/:name/execute',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['title', 'description', 'severity'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'error', 'warning', 'info'] },
            source: { type: 'string' },
            context: { type: 'object' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { name: string };
        Body: {
          title: string;
          description: string;
          severity: IncidentSeverity;
          source?: string;
          context?: Record<string, unknown>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { name } = request.params;
      const { title, description, severity, source, context } = request.body;

      const runbook = BUILTIN_RUNBOOKS_BY_NAME[name ?? ''];
      if (runbook === undefined) {
        return reply.status(404).send({
          error: 'Runbook not found',
          message: `No runbook found with name: ${name}`,
        });
      }

      // Create a manual incident.
      const incident = detector.createManualIncident(
        title,
        description,
        severity,
        context ?? {},
        runbook.name,
      );

      // Override source if provided.
      if (source !== undefined) {
        (incident as { source: string }).source = source as DetectedIncident['source'];
      }

      // Execute the runbook.
      const result = await engine.execute(runbook, incident);

      return reply.send(result);
    },
  );

  /**
   * POST /api/admin/incidents
   * Manually trigger an incident (auto-selects matching runbook).
   */
  app.post<{
    Body: {
      title: string;
      description: string;
      severity: IncidentSeverity;
      source?: string;
      context?: Record<string, unknown>;
      runbook?: string;
    };
  }>(
    '/api/admin/incidents',
    {
      schema: {
        body: {
          type: 'object',
          required: ['title', 'description', 'severity'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'error', 'warning', 'info'] },
            source: { type: 'string' },
            context: { type: 'object' },
            runbook: { type: 'string' },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: {
          title: string;
          description: string;
          severity: IncidentSeverity;
          source?: string;
          context?: Record<string, unknown>;
          runbook?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { title, description, severity, source, context, runbook: runbookName } = request.body;

      // Create the incident.
      const incident = detector.createManualIncident(
        title,
        description,
        severity,
        context ?? {},
        runbookName,
      );

      if (source !== undefined) {
        (incident as { source: string }).source = source as DetectedIncident['source'];
      }

      // Find matching runbook.
      let runbook: RunbookDefinition | undefined;

      if (runbookName !== undefined) {
        runbook = BUILTIN_RUNBOOKS_BY_NAME[runbookName];
        if (runbook === undefined) {
          return reply.status(404).send({
            error: 'Runbook not found',
            message: `No runbook found with name: ${runbookName}`,
          });
        }
      } else {
        // Auto-select: find the first runbook that matches the source and severity.
        runbook = BUILTIN_RUNBOOKS.find(
          (r) =>
            r.appliesTo.includes(incident.source) &&
            r.severities.includes(incident.severity),
        );
      }

      if (runbook === undefined) {
        return reply.send({
          incident,
          message: 'No matching runbook found. Incident was not executed.',
        });
      }

      // Execute the runbook.
      const result = await engine.execute(runbook, incident);
      return reply.send(result);
    },
  );

  /**
   * GET /api/admin/executions
   * Lists runbook execution history.
   */
  app.get('/api/admin/executions', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyAdminAuth(request, reply)) return;

    const history = engine.getExecutionHistory();
    return reply.send({
      executions: history.map((e) => ({
        executionId: e.executionId,
        runbookName: e.runbookName,
        status: e.status,
        incident: {
          id: e.incident.id,
          title: e.incident.title,
          severity: e.incident.severity,
          source: e.incident.source,
        },
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        totalDurationMs: e.totalDurationMs,
        stepCount: e.steps.length,
        error: e.error,
      })),
    });
  });

  /**
   * GET /api/admin/executions/:id
   * Returns the full details of a specific execution.
   */
  app.get<{ Params: { id: string } }>(
    '/api/admin/executions/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!verifyAdminAuth(request, reply)) return;

      const { id } = request.params;
      const execution = engine.getExecution(id ?? '');

      if (execution === undefined) {
        return reply.status(404).send({
          error: 'Execution not found',
          message: `No execution found with id: ${id}`,
        });
      }

      return reply.send(execution);
    },
  );
}