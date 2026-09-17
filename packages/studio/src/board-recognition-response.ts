export function modelErrorMessage(
  responseText: string,
  status: number,
): string {
  try {
    const payload: unknown = JSON.parse(responseText);
    if (payload && typeof payload === "object" && "error" in payload) {
      const error = (payload as { error: unknown }).error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object" && "message" in error)
        return String((error as { message: unknown }).message);
    }
  } catch {
    if (responseText.trim()) return responseText.trim();
  }
  return `LLM service returned status ${status}.`;
}

export function parseBoardRecognitionResponse(
  responseText: string,
  successful: boolean,
): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    if (!successful && responseText.trim())
      throw new Error(responseText.trim());
    throw new Error("LLM board recognition returned invalid JSON.");
  }
  if (!successful) {
    const message = modelErrorMessage(responseText, 0);
    throw new Error(
      message === "LLM service returned status 0."
        ? "LLM board recognition request failed."
        : message,
    );
  }
  return payload;
}
