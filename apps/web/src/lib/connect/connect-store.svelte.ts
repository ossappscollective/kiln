/**
 * A counter that goes up whenever "Connect your apps" saved a link, so the banners and callouts on the screen read the links again.
 * Nothing else lives here.
 */
class ConnectStore {
  version = $state(0);
  bump(): void {
    this.version += 1;
  }
}

export const connectStore = new ConnectStore();
