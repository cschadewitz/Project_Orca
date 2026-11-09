- **daemon:** Graceful shutdown now settles background direct-admission receipt
  verification before exiting, so its event-lock owner publication cannot be
  interrupted by a normal restart. Workflow execution keeps its existing lifecycle.
