import { CommitFilters, GraphCommit } from '../types';

export interface GraphFilterSnapshot {
  filters: CommitFilters;
  commits: GraphCommit[];
  hasMore: boolean;
}

export type GraphFilterLoader = (
  maxCount: number,
  skip: number,
  filters?: CommitFilters
) => Promise<GraphCommit[]>;

export class GraphFilterSession {
  private filters: CommitFilters = {};
  private commits: GraphCommit[] = [];
  private hasMore = false;
  private usingMaster = true;
  private loadingMore = false;
  private applyEpoch = 0;

  constructor(
    private readonly loadGraph: GraphFilterLoader,
    private readonly getPageSize: () => number
  ) { }

  getSnapshot(master: GraphFilterSnapshot): GraphFilterSnapshot {
    if (this.usingMaster) {
      return {
        filters: {},
        commits: master.commits,
        hasMore: master.hasMore
      };
    }
    return {
      filters: { ...this.filters },
      commits: [...this.commits],
      hasMore: this.hasMore
    };
  }

  async apply(filters: CommitFilters): Promise<GraphFilterSnapshot> {
    const pageSize = this.getPageSize();
    const epoch = ++this.applyEpoch;
    const commits = await this.loadGraph(pageSize, 0, filters);
    if (epoch !== this.applyEpoch) {
      return this.getSnapshot({ filters: {}, commits: [], hasMore: false });
    }
    this.filters = { ...filters };
    this.commits = commits;
    this.hasMore = commits.length === pageSize;
    this.usingMaster = false;
    return this.getSnapshot({ filters: {}, commits: [], hasMore: false });
  }

  clear(master: GraphFilterSnapshot): GraphFilterSnapshot {
    this.filters = {};
    this.commits = [];
    this.hasMore = false;
    this.usingMaster = true;
    return this.getSnapshot(master);
  }

  async loadMore(master: GraphFilterSnapshot): Promise<{ commits: GraphCommit[]; hasMore: boolean }> {
    if (this.loadingMore) {
      return { commits: [], hasMore: this.getSnapshot(master).hasMore };
    }
    this.loadingMore = true;
    try {
      if (this.usingMaster) {
        this.filters = {};
        this.commits = [...master.commits];
        this.hasMore = master.hasMore;
        this.usingMaster = false;
      }

      const pageSize = this.getPageSize();
      const page = await this.loadGraph(pageSize, this.commits.length, this.filters);
      this.commits = [...this.commits, ...page];
      this.hasMore = page.length === pageSize;
      return { commits: page, hasMore: this.hasMore };
    } finally {
      this.loadingMore = false;
    }
  }
}
