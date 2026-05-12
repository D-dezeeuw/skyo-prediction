export const APP_TITLE = 'skyo-prediction';

export function initialState() {
  return {
    title: APP_TITLE,
    status: 'Booting',
  };
}

export function readyState() {
  return { status: 'Ready' };
}
