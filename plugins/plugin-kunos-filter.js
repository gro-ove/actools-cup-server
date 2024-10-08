import { Hooks, Ctx, ContentCategories, Co } from '../src/app';

const KunosCars = new Set(['abarth500', 'abarth500_s1', 'alfa_romeo_giulietta_qv', 'alfa_romeo_giulietta_qv_le', 'bmw_1m', 'bmw_1m_s3', 'bmw_m3_e30',
  'bmw_m3_e30_drift', 'bmw_m3_e30_dtm', 'bmw_m3_e30_gra', 'bmw_m3_e30_s1', 'bmw_m3_e92', 'bmw_m3_e92_drift', 'bmw_m3_e92_s1', 'bmw_m3_gt2', 'bmw_z4',
  'bmw_z4_drift', 'bmw_z4_gt3', 'bmw_z4_s1', 'ferrari_312t', 'ferrari_458', 'ferrari_458_gt2', 'ferrari_458_s3', 'ferrari_599xxevo', 'ferrari_f40',
  'ferrari_f40_s3', 'ferrari_laferrari', 'ktm_xbow_r', 'lotus_2_eleven', 'lotus_2_eleven_gt4', 'lotus_49', 'lotus_98t', 'lotus_elise_sc', 'lotus_elise_sc_s1',
  'lotus_elise_sc_s2', 'lotus_evora_gtc', 'lotus_evora_gte', 'lotus_evora_gte_carbon', 'lotus_evora_gx', 'lotus_evora_s', 'lotus_evora_s_s2', 'lotus_exige_240',
  'lotus_exige_240_s3', 'lotus_exige_s', 'lotus_exige_s_roadster', 'lotus_exige_scura', 'lotus_exige_v6_cup', 'lotus_exos_125', 'lotus_exos_125_s1',
  'mclaren_mp412c', 'mclaren_mp412c_gt3', 'mercedes_sls', 'mercedes_sls_gt3', 'p4-5_2011', 'pagani_huayra', 'pagani_zonda_r', 'ruf_yellowbird',
  'shelby_cobra_427sc', 'tatuusfa1']);
const KunosTracks = new Set(['drift', 'imola', 'magione', 'monza', 'mugello', 'spa', 'trento-bondone']);

Hooks.register('core.verifyID', /** @type {(args: {categoryIndex: number, contentID: string, $: Ctx}) => void} */({ categoryIndex, contentID, $ }) => {
  if (categoryIndex > 1) return;
  if (categoryIndex === 0 && KunosCars.has(contentID)
    || categoryIndex === 1 && KunosTracks.has(contentID)
    || /^ks_/.test(contentID)) {
    throw $.requestError('This ID is reserved for original content',
      <Co.Link feedback={`I want to register ${ContentCategories[categoryIndex].id}/${contentID}`}>Request an exception…</Co.Link>);
  }
});
