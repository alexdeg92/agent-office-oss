'use strict';
const { buildStoreNavigation } = require('../../../engine/office/store-navigation');
const buildOfficeStoreVM = ({ office, index, ...selection }) => buildStoreNavigation({ ...selection,index,floors:office.rosterFloors });
module.exports = {buildOfficeStoreVM};
