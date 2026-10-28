import { Component, type ReactNode } from "react";
import { ErrorState } from "./ui";

/** A bug in one screen shows an error with a retry instead of blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    return error
      ? <div className="p-8"><ErrorState error={error.message} onRetry={() => this.setState({ error: undefined })} /></div>
      : this.props.children;
  }
}
