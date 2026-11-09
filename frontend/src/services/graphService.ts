import api from './api';

export interface GraphResponse {
  status: string;
  prompt: string;
  image_base64: string;
  chart_type?: string;
  insights?: string;
  message: string;
  records_matched?: number;
  query_plan?: Record<string, any>;
  records_in_source?: number;
  verified?: boolean;
  data_as_of?: string;
}

export const generateCustomGraph = async (prompt: string): Promise<GraphResponse> => {
  const { data } = await api.post<GraphResponse>('/graph/generate', { prompt });
  if (!data || data.status !== 'success' || !data.image_base64) {
    throw new Error(data?.message || 'The backend did not return a generated chart.');
  }
  const image = data.image_base64.startsWith('data:') ? data.image_base64 : `data:image/png;base64,${data.image_base64}`;
  return { ...data, image_base64: image };
};

export default { generateCustomGraph };
