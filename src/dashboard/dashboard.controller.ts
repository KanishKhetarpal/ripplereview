import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { PersistenceDisabledError, RunStoreService } from '../db/run-store.service';
import { renderPersistenceOff, renderRunDetail, renderRunList } from './dashboard-page';

/**
 * The dashboard: stored runs, and the blast radius of each one.
 *
 * It sits under the API's global prefix rather than at the site root, deliberately. Nest
 * can exclude routes from the prefix, but the exclusion is a per-route list that a later
 * route silently fails to be on — the failure being a human-facing page that quietly
 * starts answering only under /api/v1. One predictable location beats a special case that
 * can half-work.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly runs: RunStoreService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  async list(@Query('limit') limit?: string): Promise<string> {
    // A page, not an API: "runs are not being stored" is something to read, not a 503 in
    // a browser window. The API keeps answering with the error, because a client needs to
    // tell that apart from an empty history.
    if (!this.runs.enabled) return renderPersistenceOff();

    const parsed = Number(limit);
    const requested = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : undefined;
    return renderRunList(await this.runs.listRuns(requested));
  }

  @Get('runs/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async detail(
    // Validated before it reaches the database, for the same reason the JSON route is:
    // Postgres raises `invalid input syntax for type uuid` for anything else, which is
    // unmapped and reaches the caller as a bare 500 for a plainly bad request.
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<string> {
    if (!this.runs.enabled) return renderPersistenceOff();

    const run = await this.runs.findRun(id);
    if (!run) throw new NotFoundException(`no run with id ${id}`);
    return renderRunDetail(run);
  }
}

export { PersistenceDisabledError };
