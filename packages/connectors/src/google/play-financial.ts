import { AnalyticsError } from '../analytics-types.ts';
import { type PlayAnalyticsOptions, PlayReportsConnector } from './play-analytics.ts';

/**
 * The financial folders of the Play Console reports bucket (docs/adr/0042-earnings-and-subscription-metrics.md): `earnings/` and
 * `financial-stats/` next to the `sales/` folder of docs/adr/0038-sales-analytics.md. They need the Play Console permission "View
 * financial data" set to Global, on top of the read access to the bucket the statistics use. Same token, size caps and error mapping as the
 * statistics reports (`PlayReportsConnector.listObjects` and `downloadObject`); a refused folder is `play_sales_forbidden` (the
 * financial permission), never `bucket_forbidden`, because the statistics of the same bucket may still work.
 *
 * UNVERIFIED: that Cloud Storage answers 403 for a folder the account may not read while the rest of the bucket is readable (the
 * same assumption as for `sales/`); how it answers when the bucket itself is refused (also 403: told apart only by the statistics
 * sources working). The refusal is told apart by listing the statistics folder (`PlayReportsConnector.statsReadable`).
 */
export class PlayFinancialStorage {
  readonly #storage: PlayReportsConnector;
  readonly packageName: string;

  constructor(options: PlayAnalyticsOptions) {
    this.#storage = new PlayReportsConnector(options);
    this.packageName = options.packageName;
  }

  /**
   * A refusal of a financial folder is `play_sales_forbidden` ONLY when the statistics folder of the same bucket can still be read.
   * When that is refused too, the whole bucket is out of reach (another account's bucket, or no access at all): `bucket_forbidden`,
   * whose fix is a different one, so the person is not sent to the financial permission for nothing.
   */
  async #refused(error: unknown): Promise<never> {
    if (error instanceof AnalyticsError && error.code === 'bucket_forbidden') {
      let wholeBucket = false;
      try {
        wholeBucket = !(await this.#storage.statsReadable());
      } catch {
        wholeBucket = false;
      }
      throw new AnalyticsError(
        wholeBucket ? 'bucket_forbidden' : 'play_sales_forbidden',
        undefined,
        error.status,
      );
    }
    throw error;
  }

  /** One cheap listing of a financial folder (one object at most): resolves when it may be read, else throws the classified error. */
  async check(prefix: string): Promise<void> {
    try {
      await this.#storage.listObjects(prefix, 1);
    } catch (error) {
      await this.#refused(error);
    }
  }

  /** The object names under a prefix. A refused folder is `play_sales_forbidden`. */
  async list(prefix: string): Promise<string[]> {
    try {
      return await this.#storage.listObjects(prefix);
    } catch (error) {
      return await this.#refused(error);
    }
  }

  /** One object of the bucket. `reports_not_found` when it is gone. */
  async download(name: string): Promise<Uint8Array> {
    try {
      return await this.#storage.downloadObject(name);
    } catch (error) {
      return await this.#refused(error);
    }
  }
}
