- **app:** the workflow editor can dry-run a draft (#183). **Dry run** in the draft bar opens a
  panel where each gate and person-made decision gets a fixture choice. The result shows the
  choices made, the branches never taken, the nodes never reached and what was assumed, and
  the canvas draws the unreached part of the graph until the draft changes. A dry run opened in
  Runs is marked in its header and in every status chip (`running · dry`), and dry runs stay
  out of the Runs list and Attention unless a link opens one.
