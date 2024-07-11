import { container, InjectionToken, singleton } from 'tsyringe';
import { ref, InjectionKey, Ref, toRaw, reactive, computed } from 'vue';
import type EventEmitter from 'eventemitter3';
import { PluginDataRepository } from '../repository/PluginDataRepository';
import { JoplinDataRepository } from '../repository/JoplinDataRepository';
import {
  GeneratingProgress,
  PublishingProgress,
  initialGeneratingProgress,
  initialPublishProgress,
  PublishResults,
  PublishError,
  DEFAULT_GITHUB,
} from '../model/Publishing';
import {
  GithubClientEvents,
  githubClientToken,
  Github,
  GitEvents,
  gitClientToken,
} from '../model/GitClient';
import { AppService, FORBIDDEN } from './AppService';
import { isEmpty, noop, omit, pick, some } from 'lodash';

export enum GeneratorEvents {
  PageGenerated = 'pageGenerated',
}

export enum LocalRepoStatus {
  Ready,
  Fail,
  Initializing,
  MissingRepository,
}

const PUBLISH_RESULT_MESSAGE: Record<PublishResults, string> = {
  [PublishResults.Terminated]: 'Publishing terminated.',
  [PublishResults.Fail]:
    'This is an unexpected error, you can retry, and report it as a Github issue',
  [PublishResults.Success]: '',
};

export interface Generator extends EventEmitter<GeneratorEvents> {
  generateSite: () => Promise<string[]>;
  getOutputDir: () => Promise<string>;
}

export const generatorToken: InjectionToken<Generator> = Symbol();
export const token: InjectionKey<PublishService> = Symbol();

@singleton()
export class PublishService {
  private readonly pluginDataRepository = new PluginDataRepository();
  private readonly joplinDataRepository = new JoplinDataRepository();
  private readonly appService = container.resolve(AppService);
  private readonly generator = container.resolve(generatorToken);
  private readonly git = container.resolve(gitClientToken);
  private readonly github = container.resolve(githubClientToken);
  private files: string[] = [];
  private readonly localRepoStatus: Ref<LocalRepoStatus> = ref(LocalRepoStatus.Initializing);
  readonly repositoryName = ref('');

  readonly isRepositoryMissing = computed(
    () => this.localRepoStatus.value === LocalRepoStatus.MissingRepository,
  );
  readonly isDefaultRepository = computed(
    () => this.repositoryName.value === this.github.getDefaultRepositoryName(),
  );
  readonly githubInfo: Ref<Github | null> = ref(null);
  readonly isGenerating = ref(false);
  readonly isPublishing = ref(false);
  readonly outputDir = ref('');
  readonly generatingProgress: Required<GeneratingProgress> = reactive({
    ...initialGeneratingProgress,
  });
  readonly publishingProgress: PublishingProgress = reactive({
    ...initialPublishProgress,
  });

  constructor() {
    this.init();
  }

  private async init() {
    this.outputDir.value = await this.generator.getOutputDir();
    this.git.init(this.github, this.outputDir.value).catch(noop);

    this.git.on(GitEvents.Progress, this.refreshPublishingProgress.bind(this));
    this.git.on(GitEvents.Message, (message) => this.refreshPublishingProgress({ message }));
    this.git.on(GitEvents.LocalRepoStatusChanged, this.handleLocalRepoStatusChanged.bind(this));
    this.github.on(GithubClientEvents.InfoChanged, () => this.refreshPublishingProgress());
    this.generator.on(GeneratorEvents.PageGenerated, this.refreshGeneratingProgress.bind(this));

    this.githubInfo.value = {
      ...DEFAULT_GITHUB,
      token: (await this.joplinDataRepository.getGithubToken()) || '',
      ...(await this.pluginDataRepository.getGithubInfo()),
    };

    this.initGithubClient();
  }
  private async initGithubClient() {
    if (!this.isGithubInfoValid.value || !this.githubInfo.value) {
      return;
    }

    this.github.init(toRaw(this.githubInfo.value));
    this.repositoryName.value = this.github.getRepositoryName();
  }

  private handleLocalRepoStatusChanged(status: LocalRepoStatus) {
    this.localRepoStatus.value = status;

    if (status === LocalRepoStatus.Initializing) {
      this.refreshPublishingProgress({
        phase: 'Local repository initializing...',
        message: '',
      });
    }
  }

  isGithubInfoValid = computed(() => {
    const requiredKeys: (keyof Github)[] = ['userName', 'email', 'token'];
    const keyInfos = pick(this.githubInfo.value, requiredKeys);

    return Object.keys(keyInfos).length === requiredKeys.length && !some(keyInfos, isEmpty);
  });

  saveGithubInfo(githubInfo: Partial<Github>) {
    // Check if this.githubInfo.value exists
    if (this.githubInfo.value) {
        // Omit the 'token' property from the provided githubInfo
        const githubInfo_ = omit(githubInfo, ['token']);

        // Update the existing githubInfo with the new values
        Object.assign(this.githubInfo.value, githubInfo_);

        // Save the updated githubInfo to the repository (excluding 'token')
        this.pluginDataRepository.saveGithubInfo(omit(this.githubInfo.value, ['token']));

        // Reinitialize the Github client with the updated information
        this.initGithubClient();
    } else {
        // Handle the case where this.githubInfo.value is null
        console.error('this.githubInfo.value is null');
    }
  }

  async generateSite() {
    if (this.isGenerating.value || this.appService.getLatestWarning(FORBIDDEN.GENERATE)) {
      throw new Error('generating!');
    }

    this.isGenerating.value = true;
    this.refreshGeneratingProgress();

    try {
      const files = await this.generator.generateSite();
      this.files = files;
      this.generatingProgress.result = 'success';
      this.generatingProgress.message = `${files.length} files in totals`;
    } catch (error) {
      this.generatingProgress.result = 'fail';
      this.generatingProgress.message = (error as Error).message;
    } finally {
      this.isGenerating.value = false;
    }
  }

  async refreshGeneratingProgress(progress: GeneratingProgress = initialGeneratingProgress) {
    Object.assign(this.generatingProgress, progress);
  }

  async refreshPublishingProgress(progress: Partial<PublishingProgress> = initialPublishProgress) {
    Object.assign(this.publishingProgress, progress);
  }

  stopPublishing() {
    this.isPublishing.value = false;
    this.git.terminate();
  }

  // must confirmed by user to create repo. so we can not use `isRepositoryMissing` instead
  async publish(needToCreateRepo = false) {
    if (this.isPublishing.value) {
      return;
    }

    if (!this.isGithubInfoValid.value) {
      throw new Error('invalid github info');
    }

    const needToInit =
      this.publishingProgress.result === PublishResults.Fail ||
      needToCreateRepo ||
      this.localRepoStatus.value === LocalRepoStatus.Fail;

    if (needToInit) {
      this.refreshPublishingProgress();
    }

    this.isPublishing.value = true;

    try {
      if (needToCreateRepo && this.isRepositoryMissing.value) {
        await this.github.createRepository();
      }

      await new Promise((resolve) => setTimeout(resolve, 3000)); // a 3s delay, so user can terminate
      await this.git.push(this.files, needToInit);
      this.publishingProgress.result = PublishResults.Success;
    } catch (error) {
      if (error instanceof PublishError) {
        const message = `${error.message || ''} ${PUBLISH_RESULT_MESSAGE[error.type]}`.trim();
        this.publishingProgress.result = error.type;
        this.publishingProgress.message = message;
      } else {
        throw error;
      }
    } finally {
      this.isPublishing.value = false;
    }
  }
}
