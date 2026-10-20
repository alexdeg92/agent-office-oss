'use strict';

// Authorization needs the pre-filter board population after schema validation
// has rebuilt the public VM as a typed entity. Keep this private metadata
// outside the enumerable/wire contract and associate it with that entity.
const accessByBoard = new WeakMap();

function attach(board, access) {
  if (board && typeof board === 'object' && access) accessByBoard.set(board, access);
  return board;
}

function forBoard(board) {
  return board && typeof board === 'object'
    ? accessByBoard.get(board) || board[Symbol.for('agent-office.projects.boardAccess')] || null
    : null;
}

module.exports = { attach, forBoard };
