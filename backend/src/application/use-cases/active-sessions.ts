import { ILegacySessions } from '../../domain/contracts/legacy-sessions';
export type { ActiveUE, UeApnSession } from '../../domain/contracts/legacy-sessions';

/** Compatibility facade; infrastructure selects the legacy observation source. */
export class ActiveSessionsUseCase implements ILegacySessions {
  constructor(private readonly source: ILegacySessions) {}
  getConnected4GRadios() { return this.source.getConnected4GRadios(); }
  getActive5GUEs() { return this.source.getActive5GUEs(); }
  getActive4GUEs(imsi5GSet?: Set<string>) { return this.source.getActive4GUEs(imsi5GSet); }
}
