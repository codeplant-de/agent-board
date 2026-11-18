/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The commit the web build came from; the image build sets it, a dev server leaves it unset. */
  readonly VITE_GIT_SHA?: string;
}
