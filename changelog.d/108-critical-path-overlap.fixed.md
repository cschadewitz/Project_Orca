- **plan:** the critical path no longer counts overlapping work in full. Along a
  later-phase dependency (`other#build`) the first half of the dependent overlaps the
  upstream item, an item already underway counts half its estimate, and a dependency already satisfied
  (a produced stage) no longer counts toward the path at all (#108).
