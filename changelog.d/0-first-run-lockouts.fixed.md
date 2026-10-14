- **app:** The first-run ownership journal no longer stops the workspace after about 255
  launches. A reservation folds settled history into a verified checkpoint that keeps the
  claim chain head and effective configuration, and a journal that already reached the old
  limit is folded on its next start.
- **app:** A commit, pull or branch switch in the selected project no longer invalidates
  the saved first-run selection and strands its store. Reopening checks the repository's
  directory identity; the reviewed branch and base stay in the receipt as provenance.
